import Foundation
import Darwin
// Native messaging host: bounded frames, exact extension origin, private local socket.
let configURL=URL(fileURLWithPath:CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("browser-host.conf")
guard let raw=try? String(contentsOf:configURL,encoding:.utf8) else { exit(1) }
let config=raw.split(separator:"\n").map(String.init)
guard config.count==3,CommandLine.arguments.count>=2,CommandLine.arguments[1]==config[2],config[1].count==64 else {exit(1)}
func exact(_ count:Int)->Data? {var out=Data();while out.count<count {guard let bytes=try? FileHandle.standardInput.read(upToCount:count-out.count), !bytes.isEmpty else {return nil};out.append(bytes)};return out}
while let header=exact(4){
 let n=header.enumerated().reduce(UInt32(0)){$0 | (UInt32($1.element) << ($1.offset*8))}
 guard n>0,n<=4096,let payload=exact(Int(n)),let value=try? JSONSerialization.jsonObject(with:payload) as? [String:Any],let data=try? JSONSerialization.data(withJSONObject:["token":config[1],"payload":value]) else {exit(1)}
 let fd=socket(AF_UNIX,SOCK_STREAM,0);guard fd>=0 else {exit(1)}
 var address=sockaddr_un();address.sun_family=sa_family_t(AF_UNIX)
 let path=Array(config[0].utf8CString);guard path.count<=MemoryLayout.size(ofValue:address.sun_path) else {exit(1)}
 withUnsafeMutablePointer(to:&address.sun_path){p in p.withMemoryRebound(to:CChar.self,capacity:path.count){q in for i in path.indices {q[i]=path[i]}}}
 let result=withUnsafePointer(to:&address){p in p.withMemoryRebound(to:sockaddr.self,capacity:1){Darwin.connect(fd,$0,socklen_t(MemoryLayout<sockaddr_un>.size))}}
 guard result==0 else {close(fd);exit(1)}
 var message=data;message.append(10)
 var written=0
 let success=message.withUnsafeBytes{p -> Bool in while written<message.count{let n=Darwin.write(fd,p.baseAddress!.advanced(by:written),message.count-written);if n<=0{return false};written+=n};return true}
 close(fd);guard success else{exit(1)}
 let reply=Data("{\"ok\":true}".utf8);var size=UInt32(reply.count).littleEndian
 withUnsafeBytes(of:&size){FileHandle.standardOutput.write(Data($0))};FileHandle.standardOutput.write(reply)
}
