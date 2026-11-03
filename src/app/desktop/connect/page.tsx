"use client";
import { useEffect,useState } from "react";
type Device={id:string;name:string;expiresAt:string;revokedAt:string|null};
export default function ConnectDesktop(){
  const [name,setName]=useState("내 Windows PDF 검색기");
  const [devices,setDevices]=useState<Device[]>([]);
  const [secret,setSecret]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function api(method:"GET"|"POST"|"DELETE",body?:unknown){
    const r=await fetch("/api/desktop/tokens",{method,credentials:"same-origin",headers:{"Content-Type":"application/json"},
      ...(body?{body:JSON.stringify(body)}:{})});
    const result=await r.json();
    if(!r.ok)throw Error(result.error||"기기 설정을 불러올 수 없습니다.");
    return result;
  }
  async function refresh(){
    try{const r=await api("GET");setDevices(r.devices);}catch(e){setError(e instanceof Error?e.message:"기기 조회 실패");}
  }
  useEffect(()=>{void refresh();},[]);
  return <main style={{maxWidth:720,margin:"3rem auto",padding:"1.5rem"}}>
    <h1>Windows PDF 검색기 연결</h1>
    <p><a href="/">나의 서재로 돌아가기</a></p>
    <p>이 기기 인증키는 PDF 원본이나 OCR 본문 전송 권한이 없습니다. 서버에서 등록 대상 문서 ID만 검토합니다.</p>
    <label>기기 이름 <input value={name} onChange={e=>setName(e.target.value)} maxLength={120} disabled={busy}/></label>
    <button disabled={busy||!name.trim()} onClick={async()=>{
      setBusy(true);setError("");setSecret("");
      try{
        const result=await api("POST",{name:name.trim()});
        setSecret(result.token);
        await refresh();
      }catch(e){setError(e instanceof Error?e.message:"발급 실패");}finally{setBusy(false);}
    }}>기기 인증키 발급</button>
    {secret&&<div role="status" style={{padding:16,marginTop:16,border:"1px solid #aaa"}}>
      <strong>한 번만 표시되는 인증키</strong>
      <p>Windows 프로그램의 보호된 기기 설정에 붙여 넣으세요. 현재 3단계 검수판은 네트워크 연결 기능이 없으므로 5단계 연동 전까지 사용하지 않습니다.</p>
      <code style={{overflowWrap:"anywhere"}}>{secret}</code>
      <p><button onClick={()=>void navigator.clipboard.writeText(secret)}>복사</button> <button onClick={()=>setSecret("")}>화면에서 지우기</button></p>
    </div>}
    <h2>등록된 기기</h2>
    <ul>{devices.map(d=><li key={d.id}>
      {d.name} — {d.revokedAt?"철회됨":"만료 "+new Date(d.expiresAt).toLocaleDateString("ko-KR")}
      {!d.revokedAt&&<button disabled={busy} onClick={async()=>{
        setBusy(true);setError("");
        try{await api("DELETE",{id:d.id});await refresh();}
        catch(e){setError(e instanceof Error?e.message:"철회 실패");}
        finally{setBusy(false);}
      }}>인증 철회</button>}
    </li>)}</ul>
    {error&&<p role="alert" style={{color:"crimson"}}>{error}</p>}
  </main>;
}