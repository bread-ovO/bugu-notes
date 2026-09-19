#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <iostream>
#include <string>
#include <thread>
#include <chrono>
#include <unistd.h>
// X11 exposes foreground information. Generic XIM composition is not observable reliably.
// Never grab Tab or advertise an input lease on this backend. Wayland falls back in the host.
int main(int argc,char**argv){
 if(argc>1&&std::string(argv[1])=="--self-test"){std::cout<<"{\"selfTest\":true,\"platform\":\"linux\",\"observedUserData\":false}"<<std::endl;return 0;}
 Display* display=XOpenDisplay(nullptr);if(!display){std::cout<<"{\"type\":\"capability\",\"foreground\":false,\"input\":false,\"tab\":false,\"reason\":\"Desktop observation unavailable; use recent suggestions\"}"<<std::endl;return 0;}
 std::cout<<"{\"type\":\"capability\",\"foreground\":true,\"input\":false,\"tab\":false,\"reason\":\"X11 IME state unavailable; use click in recent suggestions\"}"<<std::endl;
 std::thread([]{std::string line;while(std::getline(std::cin,line)&&line.size()<65536){} _exit(0);}).detach();
 const Atom active=XInternAtom(display,"_NET_ACTIVE_WINDOW",False);Window previous=0;
 while(true){Atom type;int format;unsigned long count,remaining;unsigned char* data=nullptr;
  if(XGetWindowProperty(display,DefaultRootWindow(display),active,0,1,False,AnyPropertyType,&type,&format,&count,&remaining,&data)==Success&&data&&count){Window window=*reinterpret_cast<Window*>(data);if(window!=previous){previous=window;XClassHint hint{};std::string app;if(XGetClassHint(display,window,&hint)){if(hint.res_class){for(char* p=hint.res_class;*p;p++)if((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||*p=='.'||*p=='-'||*p=='_')app+=static_cast<char>(tolower(*p));XFree(hint.res_class);}if(hint.res_name)XFree(hint.res_name);}std::cout<<"{\"type\":\"foreground\",\"app\":\""<<app<<"\"}"<<std::endl;}}
  if(data)XFree(data);std::this_thread::sleep_for(std::chrono::milliseconds(200));
 }
}
