using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace KnowledgeLibrary.Setup {
 public static class Profile {
  public static readonly string[] Allowed={"DATABASE_URL","NEON_AUTH_BASE_URL","NEON_AUTH_COOKIE_SECRET","LIBRARY_OWNER_EMAIL","YES24_API_KEY","DATA4LIBRARY_KEY","GOOGLE_BOOKS_API_KEY"};
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=262144};
  public static string Serialize(object value) {return Json.Serialize(value);}
  public static Dictionary<string,string> ReadJson(string value) {return Json.Deserialize<Dictionary<string,string>>(value);}
  public static Dictionary<string,string> Filter(IDictionary<string,string> input) {
   var result=new Dictionary<string,string>();
   foreach(var key in Allowed) {string value;if(input.TryGetValue(key,out value)&&!String.IsNullOrWhiteSpace(value)) {
    if(value.Length>16000||value.IndexOfAny(new[]{'\r','\n','\0'})>=0)throw new InvalidOperationException("연결 파일에 잘못된 항목이 있습니다.");
    result[key]=value;
   }}
   foreach(var key in Allowed.Take(4))if(!result.ContainsKey(key))throw new InvalidOperationException("기존 PC의 로그인·서재 연결 설정이 필요합니다.");
   Uri db,auth;
   if(!Uri.TryCreate(result["DATABASE_URL"],UriKind.Absolute,out db)||(db.Scheme!="postgres"&&db.Scheme!="postgresql")||
      Uri.UnescapeDataString(db.UserInfo.Split(':')[0])!="library_web_runtime")throw new InvalidOperationException("서재 전용 제한 권한 DB 연결만 옮길 수 있습니다.");
   if(!Uri.TryCreate(result["NEON_AUTH_BASE_URL"],UriKind.Absolute,out auth)||auth.Scheme!="https"||!String.IsNullOrEmpty(auth.UserInfo)||
      result["NEON_AUTH_COOKIE_SECRET"].Length<32||!result["LIBRARY_OWNER_EMAIL"].Contains("@"))throw new InvalidOperationException("로그인 연결 설정을 확인해 주세요.");
   return result;
  }
  public static Dictionary<string,string> ParseEnv(string text) {
   var result=new Dictionary<string,string>();
   foreach(var line in text.Replace("\r","").Split('\n')) {
    var t=line.Trim();if(t.Length==0||t.StartsWith("#"))continue;
    var at=t.IndexOf('=');if(at<1)continue;var key=t.Substring(0,at).Trim();if(!Allowed.Contains(key))continue;var value=t.Substring(at+1).Trim();
    if(value.Length>=2&&((value[0]=='"'&&value[value.Length-1]=='"')||(value[0]=='\''&&value[value.Length-1]=='\''))) {
     value=value[0]=='"'?Json.Deserialize<string>(value):value.Substring(1,value.Length-2);
    }
    result[key]=value;
   }
   return result;
  }
  static Dictionary<string,object> ObjectAt(object value,string key) {
   var d=value as Dictionary<string,object>;object child;
   return d!=null&&d.TryGetValue(key,out child)?child as Dictionary<string,object>:null;
  }
  public static string ServeDisposition(string text) {
   var state=Json.Deserialize<Dictionary<string,object>>(text);if(state==null)return "conflict";
   if(state.Count==0)return "empty";
   var funnel=ObjectAt(state,"AllowFunnel");if(funnel!=null&&funnel.Values.Any(v=>v is bool&&(bool)v))return "conflict";
   var tcp=ObjectAt(state,"TCP");var tls=ObjectAt(tcp,"443");object https;
   var web=ObjectAt(state,"Web");
   if(tls!=null&&tls.TryGetValue("HTTPS",out https)&&https is bool&&(bool)https&&web!=null)foreach(var site in web) {
    if(!site.Key.EndsWith(":443",StringComparison.OrdinalIgnoreCase)||!SetupPaths.IsPrivateOrigin("https://"+site.Key.Substring(0,site.Key.Length-4)))continue;
    var handler=ObjectAt(ObjectAt(site.Value,"Handlers"),"/");object proxy;
    if(handler!=null&&handler.TryGetValue("Proxy",out proxy)&&
       (Convert.ToString(proxy)=="http://127.0.0.1:3001"||Convert.ToString(proxy)=="http://127.0.0.1:3001/"))return "ready";
   }
   if(state.All(item=>new[]{"TCP","Web","AllowFunnel"}.Contains(item.Key)&&item.Value is Dictionary<string,object>&&((Dictionary<string,object>)item.Value).Count==0))return "empty";
   return "conflict";
  }
  public static Dictionary<string,string> ReadSources(string protectedFile,string envFile) {
   var result=String.IsNullOrEmpty(envFile)?new Dictionary<string,string>():ParseEnv(File.ReadAllText(envFile));
   if(!String.IsNullOrEmpty(protectedFile))foreach(var item in DecodeLegacy(File.ReadAllText(protectedFile)))result[item.Key]=item.Value;
   return Filter(result);
  }
  public static Dictionary<string,string> DecodeLegacy(string text) {
   var input=ReadJson(text);string data;byte[] plain;
   if(input.TryGetValue("configurationProtected",out data)) {
    if(data.Length%2!=0||data.Length>1048576)throw new InvalidOperationException("보호 설정 파일 형식이 다릅니다.");
    var bytes=new byte[data.Length/2];for(int i=0;i<bytes.Length;i++)bytes[i]=Convert.ToByte(data.Substring(i*2,2),16);
    plain=ProtectedData.Unprotect(bytes,null,DataProtectionScope.CurrentUser);
    try{return ReadJson(Encoding.Unicode.GetString(plain));}finally{Array.Clear(plain,0,plain.Length);}
   }
   if(input.TryGetValue("protected",out data))return Unprotect(text);
   throw new InvalidOperationException("현재 Windows 사용자의 보호 설정 파일을 선택해 주세요.");
  }
  public static string Protect(IDictionary<string,string> profile) {
   var bytes=Encoding.UTF8.GetBytes(Serialize(Filter(profile)));
   try {return Serialize(new {version=1,protection="DPAPI-CurrentUser",@protected=Convert.ToBase64String(ProtectedData.Protect(bytes,null,DataProtectionScope.CurrentUser))});}
   finally {Array.Clear(bytes,0,bytes.Length);}
  }
  public static Dictionary<string,string> Unprotect(string json) {
   var input=ReadJson(json);var bytes=ProtectedData.Unprotect(Convert.FromBase64String(input["protected"]),null,DataProtectionScope.CurrentUser);
   try{return ReadJson(Encoding.UTF8.GetString(bytes));}finally{Array.Clear(bytes,0,bytes.Length);}
  }
 }
 public static class ConnectionVault {
  static readonly byte[] Magic=Encoding.ASCII.GetBytes("KLPC1");
  static byte[] Random(int size) {var b=new byte[size];using(var rng=RandomNumberGenerator.Create())rng.GetBytes(b);return b;}
  static void Password(string password) {if(password==null||password.Length<12||password.Length>1024)throw new InvalidOperationException("연결 파일 암호는 12자 이상으로 입력해 주세요.");}
  static byte[] Keys(string password,byte[] salt) {using(var derive=new Rfc2898DeriveBytes(password,salt,200000,HashAlgorithmName.SHA256))return derive.GetBytes(64);}
  static byte[] Slice(byte[] b,int offset,int count) {var r=new byte[count];Buffer.BlockCopy(b,offset,r,0,count);return r;}
  public static byte[] Encrypt(IDictionary<string,string> profile,string password) {
   Password(password);var salt=Random(16);var iv=Random(16);var keys=Keys(password,salt);
   var plain=Encoding.UTF8.GetBytes(Profile.Serialize(Profile.Filter(profile)));
   try {using(var aes=Aes.Create()) {
    aes.Key=Slice(keys,0,32);aes.IV=iv;
    byte[] cipher;using(var transform=aes.CreateEncryptor())cipher=transform.TransformFinalBlock(plain,0,plain.Length);
    using(var output=new MemoryStream())using(var writer=new BinaryWriter(output)) {
     writer.Write(Magic);writer.Write(salt);writer.Write(iv);writer.Write(cipher.Length);writer.Write(cipher);
     byte[] body=output.ToArray();using(var mac=new HMACSHA256(Slice(keys,32,32)))writer.Write(mac.ComputeHash(body));
     return output.ToArray();
    }
   }}finally{Array.Clear(keys,0,keys.Length);Array.Clear(plain,0,plain.Length);}
  }
  public static Dictionary<string,string> Decrypt(byte[] blob,string password) {
   Password(password);
   if(blob==null||blob.Length<89||blob.Length>262144||!blob.Take(5).SequenceEqual(Magic))throw new InvalidOperationException("지식서재 연결 파일을 선택해 주세요.");
   var salt=Slice(blob,5,16);var iv=Slice(blob,21,16);var size=BitConverter.ToInt32(blob,37);
   if(size<16||size%16!=0||size!=blob.Length-73)throw new InvalidOperationException("연결 파일을 읽을 수 없습니다.");
   var keys=Keys(password,salt);
   try {using(var mac=new HMACSHA256(Slice(keys,32,32))) {
    var expected=mac.ComputeHash(blob,0,blob.Length-32);int diff=0;for(int i=0;i<32;i++)diff|=expected[i]^blob[blob.Length-32+i];
    if(diff!=0)throw new InvalidOperationException("연결 파일 암호가 다르거나 파일이 손상되었습니다.");
   }
   using(var aes=Aes.Create()) {aes.Key=Slice(keys,0,32);aes.IV=iv;
    using(var transform=aes.CreateDecryptor()) {var plain=transform.TransformFinalBlock(blob,41,size);
     try {return Profile.Filter(Profile.ReadJson(Encoding.UTF8.GetString(plain)));}finally{Array.Clear(plain,0,plain.Length);}
    }
   }}finally {Array.Clear(keys,0,keys.Length);}
  }
 }
 public static class SetupPaths {
  public static string Absolute(string path) {
   if(String.IsNullOrWhiteSpace(path)||!Path.IsPathRooted(path)||path.StartsWith(@"\\")||path.IndexOfAny(new[]{'"','\r','\n','\0'})>=0)
    throw new InvalidOperationException("이 PC의 절대 폴더 경로를 선택해 주세요.");
   var full=Path.GetFullPath(path).TrimEnd('\\','/');
   if(full.Length<4||String.Equals(full,Path.GetPathRoot(full).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))
    throw new InvalidOperationException("드라이브 전체 대신 전용 폴더를 선택해 주세요.");
   return full;
  }
  public static bool IsWithin(string parent,string child) {return Path.GetFullPath(child).StartsWith(Path.GetFullPath(parent).TrimEnd('\\','/')+"\\",StringComparison.OrdinalIgnoreCase);}
  public static bool IsPrivateOrigin(string value) {
   Uri uri;return Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Port==443&&uri.AbsolutePath=="/"&&
    String.IsNullOrEmpty(uri.UserInfo)&&String.IsNullOrEmpty(uri.Query)&&String.IsNullOrEmpty(uri.Fragment)&&
    System.Text.RegularExpressions.Regex.IsMatch(uri.Host,@"^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
  }
 }
}
