#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <imm.h>
#include <uiautomation.h>
#include <vector>
#include <set>
#include <map>
#include <sstream>
#include <string>
#include <iostream>
#include <thread>
#include <mutex>
#include <chrono>
#include <algorithm>
#include <cwctype>
std::mutex guard;
std::string lease;
double deadline=0,lastInput=0;
bool swallowed=false;
HHOOK hook=nullptr;
HWND previous=nullptr;
double now();
void send(const std::string& s);
struct Candidate{long long id;std::string app;std::wstring text;};
std::vector<Candidate> candidates,staged;
unsigned long watchRevision=0;
std::string appIdentity;
std::string unhex(const std::string& value){std::string out;if(value.size()%2)return out;for(size_t i=0;i<value.size();i+=2){auto pair=value.substr(i,2);if(pair.find_first_not_of("0123456789abcdef")!=std::string::npos)return "";out+=static_cast<char>(std::stoi(pair,nullptr,16));}return out;}
std::wstring wide(const std::string& value){int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,value.data(),static_cast<int>(value.size()),nullptr,0);if(n<=0)return L"";std::wstring out(n,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,value.data(),static_cast<int>(value.size()),out.data(),n);return out;}
std::wstring normalized(const std::wstring& value){std::wstring out;bool space=false;for(auto c:value){if(iswspace(c)){space=!out.empty();}else{if(space)out+=L' ';out+=c;space=false;}}return out;}
// CUIAutomation8 exposes bounded provider calls; legacy CUIAutomation does not guarantee IUIAutomation2.
IUIAutomation2* createAutomation(){
 IUIAutomation2* uia=nullptr;
 if(FAILED(CoCreateInstance(CLSID_CUIAutomation8,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&uia))))return nullptr;
 if(FAILED(uia->put_ConnectionTimeout(100))||FAILED(uia->put_TransactionTimeout(100))){uia->Release();return nullptr;}
 return uia;
}
void observeVisible(){
 CoInitializeEx(nullptr,COINIT_MULTITHREADED);auto uia=createAutomation();if(!uia){CoUninitialize();return;}
 IUIAutomationTreeWalker* walker=nullptr;if(FAILED(uia->get_ControlViewWalker(&walker))){uia->Release();return;}
 std::map<long long,double> since;std::set<long long> emitted;HWND scannedWindow=nullptr;unsigned long scannedRevision=0;
 while(true){Sleep(1000);std::vector<Candidate> active;HWND window;unsigned long revision;std::string scannedApp;{std::lock_guard<std::mutex> lock(guard);window=GetForegroundWindow();if(window!=previous)continue;scannedApp=appIdentity;revision=watchRevision;for(auto c:candidates)if(c.app==scannedApp)active.push_back(c);}
  if(window!=scannedWindow||revision!=scannedRevision){since.clear();emitted.clear();scannedWindow=window;scannedRevision=revision;}
  if(active.empty()){since.clear();emitted.clear();{std::lock_guard<std::mutex> lock(guard);send("{\"type\":\"visible-set\",\"ids\":[]}");}continue;}
  IUIAutomationElement* root=nullptr;if(FAILED(uia->ElementFromHandle(window,&root))||!root){since.clear();emitted.clear();std::lock_guard<std::mutex> lock(guard);send("{\"type\":\"visible-set\",\"ids\":[]}");continue;}
  std::vector<IUIAutomationElement*> stack{root};std::set<long long> found;int count=0;double scanDeadline=now()+100;
  while(!stack.empty()&&count++<400&&now()<scanDeadline){auto node=stack.back();stack.pop_back();BOOL offscreen=TRUE,password=TRUE;CONTROLTYPEID type=0;node->get_CurrentIsOffscreen(&offscreen);node->get_CurrentIsPassword(&password);node->get_CurrentControlType(&type);
   if(!offscreen&&!password&&type==UIA_TextControlTypeId){BSTR name=nullptr;if(SUCCEEDED(node->get_CurrentName(&name))&&name){auto text=normalized(std::wstring(name,SysStringLen(name)));for(auto c:active)if(text==c.text&&std::count_if(active.begin(),active.end(),[&](auto x){return x.text==c.text;})==1)found.insert(c.id);SysFreeString(name);}}
   IUIAutomationElement* child=nullptr;if(!offscreen&&SUCCEEDED(walker->GetFirstChildElement(node,&child))&&child)stack.push_back(child);
   if(node!=root){IUIAutomationElement* next=nullptr;if(SUCCEEDED(walker->GetNextSiblingElement(node,&next))&&next)stack.push_back(next);}node->Release();
  }
  for(auto node:stack)node->Release();
  std::lock_guard<std::mutex> lock(guard);if(window!=GetForegroundWindow()||scannedApp!=appIdentity||revision!=watchRevision){since.clear();emitted.clear();send("{\"type\":\"visible-set\",\"ids\":[]}");continue;}
  for(auto it=since.begin();it!=since.end();)if(!found.count(it->first)){emitted.erase(it->first);it=since.erase(it);}else ++it;
  std::string ids;for(auto id:found){if(!ids.empty())ids+=",";ids+=std::to_string(id);}send("{\"type\":\"visible-set\",\"ids\":["+ids+"]}");
  for(auto id:found){if(!since.count(id))since[id]=now();if(now()-since[id]>=1500&&!emitted.count(id)){emitted.insert(id);send("{\"type\":\"visible\",\"recordId\":"+std::to_string(id)+"}");}}
 }
}

double now(){return std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();}
void send(const std::string& s){std::cout<<s<<std::endl;}
// Foreign-process TSF composition cannot be queried reliably with IMM messages.
// Fail closed for IME/CJK layouts; never infer "composition ended" from an idle timer.
bool composing(){
 HWND window=GetForegroundWindow();if(!window)return true;
 DWORD thread=GetWindowThreadProcessId(window,nullptr);if(!thread)return true;
 HKL layout=GetKeyboardLayout(thread);if(!layout)return true;
 WORD language=PRIMARYLANGID(LOWORD(reinterpret_cast<ULONG_PTR>(layout)));
 return ImmIsIME(layout)||language==LANG_CHINESE||language==LANG_JAPANESE||language==LANG_KOREAN;
}
void input(){send("{\"type\":\"input\",\"known\":true,\"composing\":"+std::string(composing()?"true":"false")+",\"lastInputAt\":"+std::to_string(lastInput)+"}");}
LRESULT CALLBACK keyboard(int code,WPARAM w,LPARAM l){
 if(code<0)return CallNextHookEx(hook,code,w,l);
 auto k=reinterpret_cast<KBDLLHOOKSTRUCT*>(l);
 std::lock_guard<std::mutex> lock(guard);
 bool down=w==WM_KEYDOWN||w==WM_SYSKEYDOWN;
 if(k->vkCode==VK_TAB&&swallowed){if(!down)swallowed=false;return 1;}
 if(down){
  if(k->vkCode==VK_TAB&&!lease.empty()&&now()<deadline&&now()-lastInput>=1200&&!composing()&&!(k->flags&LLKHF_INJECTED)&&!(GetAsyncKeyState(VK_SHIFT)&0x8000)&&!(GetAsyncKeyState(VK_CONTROL)&0x8000)&&!(GetAsyncKeyState(VK_MENU)&0x8000)&&!(GetAsyncKeyState(VK_LWIN)&0x8000)&&!(GetAsyncKeyState(VK_RWIN)&0x8000)){
   auto id=lease;lease.clear();swallowed=true;send("{\"type\":\"confirm\",\"id\":\""+id+"\"}");return 1;
  }
  lease.clear();lastInput=now();input();
 }
 return CallNextHookEx(hook,code,w,l);
}
void CALLBACK tick(HWND,UINT,UINT_PTR,DWORD){
 std::lock_guard<std::mutex> lock(guard);
 HWND foreground=GetForegroundWindow();
 if(previous!=foreground){previous=foreground;lease.clear();DWORD pid=0;GetWindowThreadProcessId(foreground,&pid);HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);wchar_t path[32768];DWORD size=32768;std::string app;
  if(process){if(QueryFullProcessImageNameW(process,0,path,&size)){std::wstring p(path,size);p=p.substr(p.find_last_of(L"\\/")+1);for(auto c:p)if(c<128&&((c>='A'&&c<='Z')||(c>='a'&&c<='z')||c=='.'||c=='-'||c=='_'||(c>='0'&&c<='9')))app+=static_cast<char>(std::towlower(c));}CloseHandle(process);}
  appIdentity=app;send("{\"type\":\"foreground\",\"app\":\""+app+"\"}");
 }
 if(now()>=deadline)lease.clear();
 if(composing())lease.clear();
 input();
}
int main(int argc,char**argv){
 if(argc>1&&std::string(argv[1])=="--self-test"){
  if(unhex("4142")!="AB"||!unhex("zz").empty()||normalized(L" A \n B ")!=L"A B")return 1;
  if(FAILED(CoInitializeEx(nullptr,COINIT_MULTITHREADED)))return 2;
  auto uia=createAutomation();if(!uia)return 3;DWORD connection=0,transaction=0;
  bool bounded=SUCCEEDED(uia->get_ConnectionTimeout(&connection))&&SUCCEEDED(uia->get_TransactionTimeout(&transaction))&&connection==100&&transaction==100;
  uia->Release();CoUninitialize();if(!bounded)return 4;
  send("{\"selfTest\":true,\"platform\":\"win32\",\"observedUserData\":false,\"boundedUia\":true}");return 0;
 }
 lastInput=now();hook=SetWindowsHookExW(WH_KEYBOARD_LL,keyboard,GetModuleHandleW(nullptr),0);
 send(std::string("{\"type\":\"capability\",\"foreground\":true,\"input\":")+(hook?"true":"false")+",\"tab\":"+(hook?"true":"false")+",\"reason\":\"IME active: click only\"}");
 std::thread([]{std::string line;while(std::getline(std::cin,line)&&line.size()<16384){std::lock_guard<std::mutex> lock(guard);if(line=="release")lease.clear();else if(line=="clearwatch")staged.clear();else if(line=="commitwatch"){candidates=staged;watchRevision++;lease.clear();send("{\"type\":\"visible-set\",\"ids\":[]}");}else if(line.rfind("watch ",0)==0){std::istringstream stream(line.substr(6));long long id;std::string app,text;if(stream>>id>>app>>text&&id>0&&staged.size()<40){auto decoded=normalized(wide(unhex(text)));if(decoded.size()>=48&&decoded.size()<=1000)staged.push_back({id,unhex(app),decoded});}}else if(line.rfind("arm ",0)==0){auto split=line.find(' ',4);if(split==std::string::npos)continue;auto id=line.substr(4,split-4);if(id.empty()||id.size()>100||id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")!=std::string::npos)continue;try{double end=std::stod(line.substr(split+1));if(hook&&end>now()&&end<=now()+8000&&now()-lastInput>=1200&&!composing()&&!(GetAsyncKeyState(VK_TAB)&0x8000)){lease=id;deadline=end;send("{\"type\":\"armed\",\"id\":\""+id+"\"}");}}catch(...) {}}}ExitProcess(0);}).detach();
 std::thread(observeVisible).detach();
 SetTimer(nullptr,0,100,tick);MSG msg;while(GetMessageW(&msg,nullptr,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}if(hook)UnhookWindowsHookEx(hook);return 0;
}
#endif
