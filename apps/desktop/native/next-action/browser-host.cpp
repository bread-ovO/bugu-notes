#include "pairing-secret.h"
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <iostream>
#include <fstream>
#include <filesystem>
#include <string>
#include <cstdint>
#include <io.h>
#include <fcntl.h>
int main(int argc,char**argv){
 int command=pairing::command(argc,argv);if(command>=0)return command;
 wchar_t path[32768];GetModuleFileNameW(nullptr,path,32768);std::wstring file(path);file=file.substr(0,file.find_last_of(L"\\/"))+L"\\browser-host.conf";
 std::ifstream cfg{std::filesystem::path(file)};std::string pipe,token,origin;std::getline(cfg,pipe);std::getline(cfg,token);std::getline(cfg,origin);token=pairing::unseal(token);
 if(argc<2||origin!=argv[1]||token.size()!=64)return 1;
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
 uint32_t size;
 while(std::cin.read(reinterpret_cast<char*>(&size),4)){
  if(size==0||size>4096)return 1;std::string payload(size,'\0');if(!std::cin.read(payload.data(),size))return 1;
  HANDLE h=CreateFileA(pipe.c_str(),GENERIC_WRITE,0,nullptr,OPEN_EXISTING,0,nullptr);if(h==INVALID_HANDLE_VALUE)return 1;
  std::string message="{\"protocolVersion\":1,\"token\":\""+token+"\",\"payload\":"+payload+"}\n";DWORD written=0;bool ok=WriteFile(h,message.data(),static_cast<DWORD>(message.size()),&written,nullptr);CloseHandle(h);if(!ok||written!=message.size())return 1;
  std::string reply="{\"ok\":true,\"protocolVersion\":1}";size=static_cast<uint32_t>(reply.size());std::cout.write(reinterpret_cast<char*>(&size),4).write(reply.data(),size).flush();
 }
 return 0;
}
#endif
#ifndef _WIN32
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <string>
#include <fstream>
#include <iostream>
#include <cstdint>
#include <cstring>
int main(int argc,char**argv){
 int command=pairing::command(argc,argv);if(command>=0)return command;
 char executable[4096];auto len=readlink("/proc/self/exe",executable,sizeof(executable)-1);if(len<0)return 1;executable[len]=0;
 std::string path(executable);std::ifstream cfg(path.substr(0,path.find_last_of('/'))+"/browser-host.conf");std::string socketPath,token,origin;std::getline(cfg,socketPath);std::getline(cfg,token);std::getline(cfg,origin);token=pairing::unseal(token);
 if(argc<2||origin!=argv[1]||token.size()!=64)return 1;
 uint32_t size;
 while(std::cin.read(reinterpret_cast<char*>(&size),4)){
  if(!size||size>4096)return 1;std::string payload(size,'\0');if(!std::cin.read(payload.data(),size))return 1;
  int fd=socket(AF_UNIX,SOCK_STREAM,0);if(fd<0)return 1;sockaddr_un address{};address.sun_family=AF_UNIX;if(socketPath.size()>=sizeof(address.sun_path)){close(fd);return 1;}std::strcpy(address.sun_path,socketPath.c_str());if(connect(fd,reinterpret_cast<sockaddr*>(&address),sizeof(address))!=0){close(fd);return 1;}
  std::string data="{\"protocolVersion\":1,\"token\":\""+token+"\",\"payload\":"+payload+"}\n";size_t sent=0;while(sent<data.size()){auto n=write(fd,data.data()+sent,data.size()-sent);if(n<=0){close(fd);return 1;}sent+=n;}close(fd);
  std::string reply="{\"ok\":true,\"protocolVersion\":1}";size=static_cast<uint32_t>(reply.size());std::cout.write(reinterpret_cast<char*>(&size),4).write(reply.data(),size).flush();
 }
}
#endif
