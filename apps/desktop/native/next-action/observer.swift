import AppKit
import ApplicationServices
import Carbon

// The helper emits only app identity and ephemeral input state. Never key codes, text or window titles.
func send(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func timestamp() -> Double { Date().timeIntervalSince1970 * 1000 }
var lease: String? = nil
var leaseEnd: Double = 0
var swallowedTab = false
var lastInput = timestamp()
var previousApp = ""
var inputKnown = false
var inputBlocked = true
struct VisibleCandidate {let id:Int;let app:String;let text:String}
var candidates:[VisibleCandidate]=[]
var visibilitySince:[Int:Double]=[:]
var emitted=Set<Int>()
var lastScan:Double=0
var previousWindow:AXUIElement? = nil
func clearVisible() {
 visibilitySince.removeAll();emitted.removeAll();previousWindow=nil
 send(["type":"visible-set","ids":[]])
}
func normalized(_ value:String)->String { value.split(whereSeparator:{$0.isWhitespace}).joined(separator:" ") }
// Read only visible static text, locally match already-authorized records, then discard the text.
func visibleRecords(_ application:NSRunningApplication) {
    var scanned=false
    defer { if !scanned { clearVisible() } }
    let relevant=candidates.filter{$0.app==application.bundleIdentifier}
    if relevant.isEmpty {return}
    let element=AXUIElementCreateApplication(application.processIdentifier)
    // A frozen client must not stall the helper and its key-release run loop.
    AXUIElementSetMessagingTimeout(element,0.02)
    var raw:CFTypeRef?
    guard AXUIElementCopyAttributeValue(element,kAXFocusedWindowAttribute as CFString,&raw) == .success,let raw=raw else{return}
    let window=unsafeBitCast(raw,to:AXUIElement.self)
    if let old=previousWindow,!CFEqual(old,window) { clearVisible() }
    previousWindow=window
    func bounds(_ node:AXUIElement)->CGRect? {
        var position:CFTypeRef?,size:CFTypeRef?
        guard AXUIElementCopyAttributeValue(node,kAXPositionAttribute as CFString,&position) == .success,
              AXUIElementCopyAttributeValue(node,kAXSizeAttribute as CFString,&size) == .success,
              let position=position,let size=size,CFGetTypeID(position)==AXValueGetTypeID(),CFGetTypeID(size)==AXValueGetTypeID() else{return nil}
        var point=CGPoint.zero,dimensions=CGSize.zero
        guard AXValueGetValue(unsafeBitCast(position,to:AXValue.self),.cgPoint,&point),AXValueGetValue(unsafeBitCast(size,to:AXValue.self),.cgSize,&dimensions) else{return nil}
        return CGRect(origin:point,size:dimensions)
    }
    guard let windowBounds=bounds(window) else{return}
    var stack:[AXUIElement]=[window],texts:[String]=[],count=0
    let deadline=timestamp()+30
    while let node=stack.popLast(),count<400,timestamp()<deadline {
        count+=1
        AXUIElementSetMessagingTimeout(node,0.02)
        var role:CFTypeRef?
        AXUIElementCopyAttributeValue(node,kAXRoleAttribute as CFString,&role)
        if role as? String == kAXStaticTextRole,let frame=bounds(node),!frame.isEmpty,windowBounds.contains(frame) {
            var value:CFTypeRef?
            AXUIElementCopyAttributeValue(node,kAXValueAttribute as CFString,&value)
            if let text=value as? String,text.utf8.count<=8000 {texts.append(normalized(text))}
        }
        var children:CFTypeRef?
        if AXUIElementCopyAttributeValue(node,kAXVisibleChildrenAttribute as CFString,&children) != .success {
            AXUIElementCopyAttributeValue(node,kAXChildrenAttribute as CFString,&children)
        }
        if let nodes=children as? [AXUIElement] {stack.append(contentsOf:nodes.prefix(400-count))}
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {return}
    var focused:CFTypeRef?
    guard AXUIElementCopyAttributeValue(element,kAXFocusedWindowAttribute as CFString,&focused) == .success,
          let focused=focused,CFEqual(focused,window) else{return}
    // Ambiguous identical messages never become concrete object observations.
    let matches=relevant.filter{c in texts.contains(where:{$0==c.text}) && relevant.filter{$0.text==c.text}.count==1}
    let ids=Set(matches.map{$0.id})
    scanned=true
    send(["type":"visible-set","ids":Array(ids)])
    visibilitySince=visibilitySince.filter{ids.contains($0.key)};emitted=emitted.intersection(ids)
    for c in matches {
        if visibilitySince[c.id]==nil {visibilitySince[c.id]=timestamp()}
        if timestamp()-(visibilitySince[c.id] ?? timestamp())>=1500 && !emitted.contains(c.id) {
            emitted.insert(c.id);send(["type":"visible","recordId":c.id])
        }
    }
}
if CommandLine.arguments.contains("--self-test") {
    precondition(normalized(" 甲\n 乙 ")=="甲 乙")
    precondition("fixture-123".range(of:"^[a-zA-Z0-9-]{1,100}$",options:.regularExpression) != nil)
    precondition("invalid;command".range(of:"^[a-zA-Z0-9-]{1,100}$",options:.regularExpression) == nil)
    send(["selfTest":true,"platform":"darwin","observedUserData":false]);exit(0)
}
var tap: CFMachPort?
let requestPermission = CommandLine.arguments.contains("--permission")
if requestPermission { _ = CGRequestListenEventAccess() }
var trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: requestPermission] as CFDictionary)
func asciiInput() -> Bool {
    guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
          let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsASCIICapable) else { return false }
    return unsafeBitCast(pointer, to: CFBoolean.self) == kCFBooleanTrue
}
func releaseLease() { lease = nil; leaseEnd = 0 }
let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
if trusted {
    tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
        eventsOfInterest: CGEventMask(mask), callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            releaseLease(); inputKnown = false
            send(["type":"input", "known":false, "composing":true, "lastInputAt":timestamp()])
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if type == .keyUp && code == 48 && swallowedTab { swallowedTab = false; return nil }
        if type == .keyDown && code == 48 && swallowedTab { return nil }
        if type == .keyDown && code == 48, let id = lease,
           timestamp() < leaseEnd, timestamp() - lastInput >= 1200,
           inputKnown && !inputBlocked && asciiInput(),
           event.flags.intersection([.maskShift,.maskControl,.maskAlternate,.maskCommand]).isEmpty,
           event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            releaseLease(); swallowedTab = true
            send(["type":"confirm", "id":id]); return nil
        }
        if type == .keyDown || type == .flagsChanged {
            releaseLease(); lastInput = timestamp()
            send(["type":"input", "known":inputKnown, "composing":!asciiInput(), "lastInputAt":lastInput])
        }
        return Unmanaged.passUnretained(event)
    }, userInfo: nil)
}
if let tap = tap {
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
}
send(["type":"capability", "foreground":true,"input":tap != nil,"tab":tap != nil,
      "reason":tap == nil ? "需要辅助功能与输入监控许可；当前仅支持点击" : "非英文输入法无法可靠确认组合输入结束时，仅支持点击"])
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    let app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
    if app != previousApp { releaseLease(); previousApp = app; send(["type":"foreground", "app":app]) }
    if timestamp() >= leaseEnd { releaseLease() }
    if timestamp()-lastScan>=1000 {
        lastScan=timestamp()
        let permission=AXIsProcessTrusted()
        if (trusted && !permission) || (tap != nil && !CGPreflightListenEventAccess()) {
            releaseLease();clearVisible()
            if let old=tap {CGEvent.tapEnable(tap:old,enable:false);CFMachPortInvalidate(old)}
            tap=nil;inputKnown=false
            send(["type":"locked"])
            send(["type":"capability","foreground":true,"input":false,"tab":false,"reason":"系统权限已撤销；重新授权后开启观察"])
        }
        trusted=permission
        if trusted,let current=NSWorkspace.shared.frontmostApplication { visibleRecords(current) }
        else { clearVisible() }
    }
    let known = tap != nil && (tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false)
    let blocked = !asciiInput()
    if known != inputKnown || blocked != inputBlocked {
        releaseLease(); inputKnown = known; inputBlocked = blocked
        send(["type":"input","known":known,"composing":blocked,"lastInputAt":lastInput])
    }
}
let center = NSWorkspace.shared.notificationCenter
for name in [NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willSleepNotification] {
    center.addObserver(forName:name,object:nil,queue:.main) { _ in releaseLease(); send(["type":"locked"]) }
}
DispatchQueue.global().async {
    while let line = readLine(), line.utf8.count < 65536 {
        let parts = line.split(separator:" ").map(String.init)
        DispatchQueue.main.async {
            if line.hasPrefix("watch "),let data=line.dropFirst(6).data(using:.utf8),let rows=(try? JSONSerialization.jsonObject(with:data)) as? [[String:Any]],rows.count<=40 {
                candidates=rows.compactMap{r in guard let id=r["recordId"] as? Int,let app=r["app"] as? String,let text=r["text"] as? String,id>0,text.count>=48,text.count<=1000 else{return nil};return VisibleCandidate(id:id,app:app,text:normalized(text))}
                clearVisible()
            }
            if parts.first == "release" { releaseLease() }
            if parts.first == "arm", parts.count == 3, let until = Double(parts[2]),
               parts[1].range(of:"^[a-zA-Z0-9-]{1,100}$",options:.regularExpression) != nil,
               until > timestamp(), until <= timestamp()+8000,
               inputKnown && !inputBlocked && timestamp()-lastInput>=1200 &&
               !CGEventSource.keyState(.combinedSessionState, key:48) {
                lease=parts[1];leaseEnd=until
                send(["type":"armed","id":parts[1]])
            }
        }
    }
    DispatchQueue.main.async { releaseLease(); exit(0) }
}
RunLoop.main.run()
