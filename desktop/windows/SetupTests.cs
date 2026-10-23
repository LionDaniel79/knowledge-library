using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using KnowledgeLibrary.Setup;
public static class SetupTests {
 static int count;
 static void Check(bool ok,string label) { if(!ok)throw new Exception(label);count++; }
 static void Reject(Action call,string label) { bool rejected=false;try{call();}catch(Exception){rejected=true;}Check(rejected,label); }
 public static int Main(string[] args) {
  try {
   var profile=new Dictionary<string,string>{{"DATABASE_URL","postgresql://library_web_runtime:fixture@db.example/library?sslmode=require"},{"NEON_AUTH_BASE_URL","https://auth.example/neondb/auth"},{"NEON_AUTH_COOKIE_SECRET",new string('c',40)},{"LIBRARY_OWNER_EMAIL","owner@example.invalid"},{"YES24_API_KEY","fixture-key"},{"OPENAI_API_KEY","must-not-export"},{"ZOTERO_API_KEY","must-not-export"},{"LIBRARY_PDF_ROOT",@"Z:\old-pc"}};
   var safe=Profile.Filter(profile);
   Check(safe.Count==5,"profile must export only restricted connection fields");
   var blob=ConnectionVault.Encrypt(safe,"fixture-password-123");
   Check(!Encoding.UTF8.GetString(blob).Contains("fixture-key"),"export must not contain plaintext keys");
   Check(ConnectionVault.Decrypt(blob,"fixture-password-123")["YES24_API_KEY"]=="fixture-key","cross-PC encrypted connection must roundtrip");
   Reject(()=>ConnectionVault.Decrypt(blob,"another-password"),"wrong password must fail");
   var altered=(byte[])blob.Clone();altered[altered.Length-1]^=1;Reject(()=>ConnectionVault.Decrypt(altered,"fixture-password-123"),"tampered connection must fail");
   Reject(()=>ConnectionVault.Encrypt(safe,"short"),"short password rejected");
   var protectedProfile=Profile.Protect(safe);
   Check(Profile.Unprotect(protectedProfile)["LIBRARY_OWNER_EMAIL"]=="owner@example.invalid","current-user DPAPI roundtrip");
   Check(!protectedProfile.Contains("fixture-key"),"local profile must contain no plaintext key");
   var bad=new Dictionary<string,string>(safe);bad["DATABASE_URL"]="postgresql://neondb_owner:fixture@db.example/library";Reject(()=>Profile.Filter(bad),"admin role not exported");
   bad=new Dictionary<string,string>(safe);bad.Remove("NEON_AUTH_COOKIE_SECRET");Reject(()=>Profile.Filter(bad),"missing login secret rejected");
   bad=new Dictionary<string,string>(safe);bad["YES24_API_KEY"]="first\nSECOND=bad";Reject(()=>Profile.Filter(bad),"newline rejected");
   Check(SetupPaths.Absolute(@"D:\서재\실행") == @"D:\서재\실행","Korean and spaced paths supported");
   Reject(()=>SetupPaths.Absolute(@"D:\"),"volume root rejected");
   Reject(()=>SetupPaths.Absolute("relative"),"relative folder rejected");
   Reject(()=>SetupPaths.Absolute(@"D:\server"";bad"),"command delimiter rejected");
   Check(SetupPaths.IsWithin(@"D:\library",@"D:\library\release\a"),"child accepted");
   Check(!SetupPaths.IsWithin(@"D:\library",@"D:\library-other\a"),"prefix sibling rejected");
   Check(SetupPaths.IsPrivateOrigin("https://new-pc.tail1234.ts.net"),"private address accepted");
   Check(!SetupPaths.IsPrivateOrigin("https://public.example"),"public PC exposure rejected");
   Check(!SetupPaths.IsPrivateOrigin("https://new-pc.tail1234.ts.net/path"),"non-origin rejected");
   var env=Profile.ParseEnv("NEON_AUTH_COOKIE_SECRET=\"abc#def\"\nYES24_API_KEY='book-key'\n# comment\nUNUSED=no");
   Check(env["NEON_AUTH_COOKIE_SECRET"]=="abc#def" && env["YES24_API_KEY"]=="book-key","environment quotes and hash preserved");
   Check(!Profile.ParseEnv("LIBRARY_PDF_ROOT=\"C:\\Users\\other\\books\"\nYES24_API_KEY=fixture").ContainsKey("LIBRARY_PDF_ROOT"),"ignored machine paths cannot break connection export");
   var legacyPlain=new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(safe);
   var legacyCipher=System.Security.Cryptography.ProtectedData.Protect(Encoding.Unicode.GetBytes(legacyPlain),null,System.Security.Cryptography.DataProtectionScope.CurrentUser);
   var legacy="{\"configurationProtected\":\""+BitConverter.ToString(legacyCipher).Replace("-","").ToLowerInvariant()+"\"}";
   Check(Profile.DecodeLegacy(legacy)["YES24_API_KEY"]=="fixture-key","existing PowerShell DPAPI profile accepted");
   Check(Profile.ServeDisposition("{}")=="empty","empty Tailscale configuration can be set");
   Check(Profile.ServeDisposition("{\"TCP\":{\"443\":{\"HTTPS\":true}},\"Web\":{\"pc.tail123.ts.net:443\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127.0.0.1:3001\"}}}}}")=="ready","existing exact root connection is reused without changes");
   Check(Profile.ServeDisposition("{\"TCP\":{\"443\":{\"HTTPS\":true},\"8443\":{\"HTTPS\":true}},\"Web\":{\"pc.tail123.ts.net:443\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127.0.0.1:8080\"}}},\"pc.tail123.ts.net:8443\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127.0.0.1:3001\"}}}}}")=="conflict","same backend on another port cannot authorize overwriting root");
   Check(Profile.ServeDisposition("{\"Web\":{\"pc.tail123.ts.net:443\":{\"Handlers\":{\"/library\":{\"Proxy\":\"http://127.0.0.1:3001\"}}}}}")=="conflict","same backend mounted at subpath is preserved");
   if(args.Length==2) {
    var actual=Profile.ReadSources(args[0],args[1]);
    var sealedActual=ConnectionVault.Encrypt(actual,"in-memory-check-only");
    Check(ConnectionVault.Decrypt(sealedActual,"in-memory-check-only").Count==actual.Count,"existing protected configuration imports without exposing values");
    actual.Clear();Array.Clear(sealedActual,0,sealedActual.Length);
   }
   Console.WriteLine("PASS "+count+" setup core assertions");return 0;
  } catch(Exception e) {Console.Error.WriteLine(e.Message);return 1;}
 }
}
