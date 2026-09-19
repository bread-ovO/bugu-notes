#pragma once
#include <string>
#include <iostream>
#include <vector>
#include <algorithm>
#ifdef _WIN32
#include <windows.h>
#include <wincrypt.h>
#else
#include <libsecret/secret.h>
#endif
namespace pairing {
inline bool token(const std::string& value){return value.size()==64&&value.find_first_not_of("0123456789abcdef")==std::string::npos;}
#ifdef _WIN32
inline std::string hex(const unsigned char* bytes,size_t length){const char* h="0123456789abcdef";std::string value;for(size_t i=0;i<length;i++){value+=h[bytes[i]>>4];value+=h[bytes[i]&15];}return value;}
inline std::vector<unsigned char> bytes(const std::string& hex){std::vector<unsigned char> result;if(hex.size()%2||hex.find_first_not_of("0123456789abcdef")!=std::string::npos)return result;for(size_t i=0;i<hex.size();i+=2)result.push_back(static_cast<unsigned char>(std::stoi(hex.substr(i,2),nullptr,16)));return result;}
inline std::string seal(const std::string& value){DATA_BLOB input{static_cast<DWORD>(value.size()),reinterpret_cast<BYTE*>(const_cast<char*>(value.data()))},out{};if(!CryptProtectData(&input,L"BUGU next-action pairing",nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&out))return "";auto sealed="dpapi:"+hex(out.pbData,out.cbData);LocalFree(out.pbData);return sealed;}
inline std::string unseal(const std::string& sealed){if(sealed.rfind("dpapi:",0)!=0||sealed.size()>8192)return "";auto data=bytes(sealed.substr(6));if(data.empty())return "";DATA_BLOB input{static_cast<DWORD>(data.size()),data.data()},out{};if(!CryptUnprotectData(&input,nullptr,nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&out))return "";std::string value(reinterpret_cast<char*>(out.pbData),out.cbData);SecureZeroMemory(out.pbData,out.cbData);LocalFree(out.pbData);return token(value)?value:"";}
inline bool forget(const std::string& sealed){return sealed.rfind("dpapi:",0)==0;}
#else
inline const SecretSchema* schema(){static const SecretSchema s={"dev.bugu.next-action.pairing",SECRET_SCHEMA_NONE,{{"account",SECRET_SCHEMA_ATTRIBUTE_STRING},{nullptr,static_cast<SecretSchemaAttributeType>(0)}}};return &s;}
inline bool reference(const std::string& value){return value.rfind("secret:",0)==0&&value.size()==43&&value.substr(7).find_first_not_of("abcdef0123456789-")==std::string::npos;}
inline std::string seal(const std::string& value){char* id=g_uuid_string_random();std::string account(id);g_free(id);GError* error=nullptr;bool ok=secret_password_store_sync(schema(),SECRET_COLLECTION_DEFAULT,"BUGU next-action pairing",value.c_str(),nullptr,&error,"account",account.c_str(),nullptr);if(error)g_error_free(error);return ok?"secret:"+account:"";}
inline std::string unseal(const std::string& sealed){if(!reference(sealed))return "";GError* error=nullptr;char* password=secret_password_lookup_sync(schema(),nullptr,&error,"account",sealed.substr(7).c_str(),nullptr);std::string value=password?password:"";if(password)secret_password_free(password);if(error)g_error_free(error);return token(value)?value:"";}
inline bool forget(const std::string& sealed){if(!reference(sealed))return false;GError* error=nullptr;secret_password_clear_sync(schema(),nullptr,&error,"account",sealed.substr(7).c_str(),nullptr);bool ok=!error;if(error)g_error_free(error);return ok;}
#endif
inline int command(int argc,char** argv){if(argc!=2||std::string(argv[1]).rfind("--",0)!=0)return -1;std::string value;std::getline(std::cin,value);if(value.size()>8192)return 1;std::string op=argv[1],result;if(op=="--seal"&&token(value))result=seal(value);else if(op=="--unseal")result=unseal(value);else if(op=="--forget")return forget(value)?0:1;else return 1;if(result.empty())return 1;std::cout<<result<<std::endl;return 0;}
}
