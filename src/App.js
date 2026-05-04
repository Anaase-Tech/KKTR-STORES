import { useState, useEffect, useRef, Component } from "react";
import { initializeApp, getApps } from "firebase/app";
import {
  initializeFirestore, doc, setDoc, getDoc, getDocs, addDoc,
  updateDoc, deleteDoc, collection, query, where, orderBy,
  onSnapshot, serverTimestamp, enableNetwork, runTransaction, increment
} from "firebase/firestore";
import { getDatabase, ref, push, onValue, off, update } from "firebase/database";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "firebase/storage";

// ─── FIREBASE v7.0 — PROVEN WORKING CONFIG ───────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDzpR0Yrkj0jDI_4eFP9ARJOwdUvptlVMY",
  authDomain: "kktr-stores-test.firebaseapp.com",
  projectId: "kktr-stores-test",
  storageBucket: "kktr-stores-test.appspot.com", // FIXED: was .firebasestorage.app
  messagingSenderId: "47352288339",
  appId: "1:47352288339:web:7f3b7174cb02c6bc7722a6",
  databaseURL: "https://kktr-stores-test-default-rtdb.firebaseio.com"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// PROVEN WORKING — long polling for Ghana mobile networks
const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false
});
const rtdb = getDatabase(app);
const storage = getStorage(app);
enableNetwork(db).catch(e => console.log("enableNetwork:", e.message));

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const DEPTS = ["Log Yard","Sawmill","Saw Shop","Workshop","Charcoal","Kindry",
               "Chainsaw","Security","Administration","HR"];
const CHOP_RATE = 10;
const ADMIN_USER = "abraham.sackey";
// ADMIN_PASS removed from code — hash stored in Firestore only

// Safe name helper — prevents crash if user.name is undefined
const getFirstName = u => (u?.name||u?.username||"User").split(" ")[0];

// ─── ROLE-BASED PERMISSIONS ───────────────────────────────────────────────────
const PERMISSIONS = {
  admin:         ["all"],
  coo:           ["reqs_approve_coo","reqs_create","chat","reports"],
  store_manager: ["lubes_read","lubes_write","items_read","items_write",
                  "transactions","issue_stock","receipts","reports","chat","reqs_view"],
  hr:            ["attendance","chop_money","staff_management","chat","reqs_create","reqs_view"],
  dept:          ["reqs_create","reqs_view","chat","attendance","receipts"]
};
function can(user, perm){
  if(!user||!user.role) return false;
  const perms = PERMISSIONS[user.role] || [];
  return perms.includes("all") || perms.includes(perm);
}

const C = {
  forest:"#1a2e1a", bark:"#3d2b1f", timber:"#8B5E3C", gold:"#C8951A",
  cream:"#F5EDD6", sage:"#4a6741", mist:"#e8f0e8", danger:"#c0392b",
  warn:"#e67e22", ok:"#27ae60", ink:"#0d1a0d", white:"#ffffff",
  panel:"#f0ebe0", border:"#c9b99a", blue:"#2980b9",
};

const DEF_LUBES = [
  {name:"Hydraulic Oil",unit:"Litres",minStock:50},
  {name:"Engine Oil",unit:"Litres",minStock:30},
  {name:"Petrol",unit:"Litres",minStock:100},
  {name:"Diesel",unit:"Litres",minStock:200},
  {name:"Premix",unit:"Litres",minStock:50},
];

// ─── SESSION ──────────────────────────────────────────────────────────────────
const SK = "kktr_v7";
const Sess = {
  save: u => {
    try{
      // Always ensure name exists before saving
      const safe={...u, name:u.name||u.username||"User"};
      localStorage.setItem(SK,JSON.stringify(safe));
    }catch{}
  },
  load: ()  => {
    try{
      const v=localStorage.getItem(SK);
      if(!v) return null;
      const u=JSON.parse(v);
      // Ensure name field always exists on load
      if(!u.name) u.name=u.username||"User";
      return u;
    }catch{return null;}
  },
  clear:()  => { try{ localStorage.removeItem(SK); }catch{} },
};

// ─── PASSWORD HASH ────────────────────────────────────────────────────────────
async function hashPwd(pwd) {
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(pwd + "kktr_salt_2024"));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2,"0")).join("");
}

// ─── NOTIFICATION HELPER ─────────────────────────────────────────────────────
async function sendNotification(db, fromUser, toDept, toUserId, toUserName, type, message, extra={}){
  try {
    await addDoc(collection(db,"notifications"),{
      type, message,
      toDept, toUserId, toUserName,
      fromName:fromUser?.name||fromUser?.username||"System",
      fromRole:fromUser?.role||"system",
      read:false,
      createdAt:serverTimestamp(),
      ...extra
    });
  } catch(e){ console.log("Notification failed:",e.message); }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split("T")[0];
const fmtDate = ts => {
  if (!ts) return "";
  try { const d = ts.toDate?ts.toDate():new Date(ts);
    return d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}); }
  catch { return ""; }
};
const fmtTime = ts => {
  if (!ts) return "";
  try { const d = ts.toDate?ts.toDate():new Date(typeof ts==="number"?ts:ts);
    return d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}); }
  catch { return ""; }
};
const tsToStr = ts => {
  if (!ts) return "";
  try { const d=ts.toDate?ts.toDate():new Date(ts); return d.toISOString().split("T")[0]; }
  catch { return ""; }
};
const weekStart = () => {
  const d=new Date(); d.setDate(d.getDate()-d.getDay());
  return d.toISOString().split("T")[0];
};
const monthStart = () => {
  const n=new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-01`;
};

// ─── UI PRIMITIVES ────────────────────────────────────────────────────────────
function Card({children,style={},onClick}){
  return <div onClick={onClick} style={{background:C.white,borderRadius:"14px",padding:"14px",
    boxShadow:"0 2px 10px rgba(26,46,26,0.12)",border:`1px solid ${C.border}`,
    marginBottom:"10px",cursor:onClick?"pointer":"default",...style}}>{children}</div>;
}
function Inp({label,wrapStyle={},...props}){
  return(
    <div style={{marginBottom:"10px",...wrapStyle}}>
      {label&&<label style={{display:"block",fontSize:"0.72rem",fontWeight:700,
        color:C.forest,marginBottom:"4px",textTransform:"uppercase",
        letterSpacing:"0.05em"}}>{label}</label>}
      <input {...props} style={{width:"100%",padding:"10px 12px",
        border:`1.5px solid ${C.border}`,borderRadius:"9px",fontSize:"0.9rem",
        fontFamily:"inherit",background:C.white,color:C.ink,
        boxSizing:"border-box",...(props.style||{})}}/>
    </div>
  );
}
function Sel({label,children,wrapStyle={},...props}){
  return(
    <div style={{marginBottom:"10px",...wrapStyle}}>
      {label&&<label style={{display:"block",fontSize:"0.72rem",fontWeight:700,
        color:C.forest,marginBottom:"4px",textTransform:"uppercase",
        letterSpacing:"0.05em"}}>{label}</label>}
      <select {...props} style={{width:"100%",padding:"10px 12px",
        border:`1.5px solid ${C.border}`,borderRadius:"9px",fontSize:"0.9rem",
        fontFamily:"inherit",background:C.white,color:C.ink,
        boxSizing:"border-box"}}>{children}</select>
    </div>
  );
}
function Btn({children,onClick,color=C.forest,outline=false,sm=false,
  disabled=false,loading=false,style={}}){
  return(
    <button onClick={onClick} disabled={disabled||loading} style={{
      background:outline?"transparent":color,color:outline?color:C.white,
      border:`2px solid ${color}`,borderRadius:"10px",
      padding:sm?"7px 14px":"11px 20px",fontFamily:"inherit",
      fontSize:sm?"0.8rem":"0.88rem",fontWeight:700,
      cursor:(disabled||loading)?"not-allowed":"pointer",
      opacity:(disabled||loading)?0.6:1,display:"inline-flex",
      alignItems:"center",gap:"6px",transition:"all 0.15s",...style}}>
      {loading?"⏳ Please wait…":children}
    </button>
  );
}
function Badge({color=C.sage,children}){
  return <span style={{background:color,color:"#fff",fontSize:"0.65rem",
    padding:"2px 8px",borderRadius:"20px",fontWeight:700,display:"inline-block"}}>
    {children}</span>;
}
function useToast(){
  const [t,setT]=useState(null);
  const show=(m,k="ok")=>{setT({m,k});setTimeout(()=>setT(null),3200);};
  const el=t?<div style={{position:"fixed",top:"16px",left:"50%",
    transform:"translateX(-50%)",
    background:{ok:C.ok,warn:C.warn,danger:C.danger}[t.k]||C.ok,
    color:"#fff",padding:"10px 20px",borderRadius:"30px",fontWeight:700,
    fontSize:"0.88rem",zIndex:9999,boxShadow:"0 4px 20px rgba(0,0,0,0.3)",
    maxWidth:"90vw",textAlign:"center",whiteSpace:"pre-wrap"}}>{t.m}</div>:null;
  return [el,show];
}
function Modal({title,onClose,children}){
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",
      zIndex:1000,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
      onClick={onClose}>
      <div style={{background:C.white,borderRadius:"20px 20px 0 0",width:"100%",
        maxWidth:"480px",maxHeight:"90vh",overflowY:"auto",padding:"20px"}}
        onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",
          alignItems:"center",marginBottom:"16px"}}>
          <span style={{fontSize:"1.1rem",fontWeight:800,color:C.forest}}>{title}</span>
          <button onClick={onClose} style={{background:"none",border:"none",
            cursor:"pointer",fontSize:"1.4rem",color:C.timber}}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function TabBar({tabs,active,onSelect}){
  return(
    <div style={{background:C.panel,borderRadius:"10px",display:"flex",
      gap:"3px",padding:"4px",marginBottom:"14px"}}>
      {tabs.map(t=>(
        <button key={t.id} onClick={()=>onSelect(t.id)} style={{flex:1,
          padding:"8px 0",border:"none",
          background:active===t.id?C.forest:"transparent",
          color:active===t.id?C.white:C.timber,fontFamily:"inherit",
          fontWeight:700,fontSize:"0.75rem",borderRadius:"7px",cursor:"pointer"}}>
          {t.label}</button>
      ))}
    </div>
  );
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function AuthScreen({onLogin}){
  const [mode,setMode]=useState("login");
  if(mode==="register") return <RegisterScreen onBack={()=>setMode("login")}/>;
  if(mode==="forgot") return <ForgotScreen onBack={()=>setMode("login")}/>;
  return <LoginScreen onLogin={onLogin}
    onRegister={()=>setMode("register")}
    onForgot={()=>setMode("forgot")}/>;
}

function LoginScreen({onLogin,onRegister,onForgot}){
  const [u,setU]=useState("");
  const [p,setP]=useState("");
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);
  const [logo,setLogo]=useState(null);

  useEffect(()=>{
    // Unregister any old service workers
    if("serviceWorker" in navigator){
      navigator.serviceWorker.getRegistrations().then(regs=>{
        regs.forEach(r=>r.unregister());
      });
    }
    // Load logo
    getDoc(doc(db,"settings","company"))
      .then(s=>{ if(s.exists()&&s.data().logoUrl) setLogo(s.data().logoUrl); })
      .catch(()=>{});
  },[]);

  const go=async()=>{
    const uname=u.trim().toLowerCase();
    if(!uname||!p){ setErr("Enter your username and password."); return; }
    setLoading(true); setErr("");

    // 1. Check local cache first — instant, zero network
    const cached=Sess.load();
    if(cached&&cached.username===uname){
      try {
        const pwdHash=await hashPwd(p);
        if(cached.pwdHash===pwdHash){ onLogin(cached); return; }
        setErr("Wrong password."); setLoading(false); return;
      } catch(e2){}
    }

    // 2. Firestore lookup — username is document ID, O(1) read
    try {
      const pwdHash=await hashPwd(p);
      const snap=await getDoc(doc(db,"users",uname));

      if(!snap.exists()){
        // Admin not in Firestore yet — deploy script should have created it
        // If still missing, the password itself becomes the hash (first-time setup)
        if(uname===ADMIN_USER){
          const adminDoc={id:ADMIN_USER,username:ADMIN_USER,name:"Abraham Sackey",
            dept:"Administration",role:"admin",approved:true,
            pwdHash:pwdHash,createdAt:serverTimestamp()};
          await setDoc(doc(db,"users",ADMIN_USER),adminDoc);
          Sess.save(adminDoc); onLogin(adminDoc); return;
        }
        setErr("Wrong username or password."); setLoading(false); return;
      }

      const data={...snap.data(),id:snap.id};
      if(!data.approved&&data.role!=="admin"){
        setErr("Account awaiting approval from Abraham Sackey.");
        setLoading(false); return;
      }
      if(data.pwdHash!==pwdHash){
        if(data.pendingPasswordReset){
          const rHash=await hashPwd(data.pendingPasswordReset);
          if(pwdHash===rHash){
            await setDoc(doc(db,"users",uname),
              {...data,pwdHash:rHash,pendingPasswordReset:null},{merge:true});
            const upd={...data,pwdHash:rHash,pendingPasswordReset:null};
            Sess.save(upd); onLogin(upd); return;
          }
        }
        setErr("Wrong password."); setLoading(false); return;
      }
      // Format display name properly — mutate property, not reassign const
      if(!data.name || data.name === data.username) {
        if(data.username && data.username.includes(".")) {
          const parts = data.username.split(".");
          const formatted = parts.map(pt => pt.charAt(0).toUpperCase()+pt.slice(1)).join(" ");
          data.name = formatted;
          setDoc(doc(db,"users",uname),{name:formatted},{merge:true}).catch(()=>{});
        }
      }
      Sess.save(data); onLogin(data);
    } catch(e){
      console.error("Login error:",e);
      const cached2=Sess.load();
      if(cached2&&cached2.username===uname){ onLogin(cached2); return; }
      setErr("Error: "+e.message+(e.code?" ("+e.code+")":""));
      setLoading(false);
    }
  };

  return(
    <div style={{minHeight:"100vh",
      background:`linear-gradient(160deg,${C.forest},${C.bark} 60%,${C.timber})`,
      display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",padding:"24px",fontFamily:"inherit"}}>
      <div style={{textAlign:"center",marginBottom:"24px"}}>
        {logo
          ?<img src={logo} alt="logo" style={{width:"80px",height:"80px",
              borderRadius:"50%",objectFit:"cover",margin:"0 auto 12px",
              display:"block",border:`3px solid ${C.gold}`}}/>
          :<div style={{width:"80px",height:"80px",borderRadius:"50%",
              background:C.gold,margin:"0 auto 12px",display:"flex",
              alignItems:"center",justifyContent:"center",fontSize:"2.4rem",
              boxShadow:"0 4px 20px rgba(0,0,0,0.4)"}}>🪵</div>}
        <div style={{fontSize:"1.4rem",color:C.cream,fontWeight:800,lineHeight:1.2}}>
          Kete Krachi<br/>Timber Recovery</div>
        <div style={{fontSize:"0.7rem",color:"rgba(245,237,214,0.6)",marginTop:"6px",
          letterSpacing:"0.15em",textTransform:"uppercase"}}>Store Management System</div>
      </div>
      <div style={{background:C.white,borderRadius:"20px",padding:"24px",
        width:"100%",maxWidth:"340px",boxShadow:"0 8px 40px rgba(0,0,0,0.4)"}}>
        <h2 style={{color:C.forest,marginTop:0,marginBottom:"18px",
          fontSize:"1.1rem",fontWeight:800}}>Sign In</h2>
        <Inp label="Username" value={u} onChange={e=>setU(e.target.value)}
          placeholder="e.g. abraham.sackey" autoCapitalize="none"
          onKeyDown={e=>e.key==="Enter"&&go()}/>
        <Inp label="Password" type="password" value={p}
          onChange={e=>setP(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}/>
        {err&&<div style={{color:err.startsWith("✅")?C.ok:C.danger,
          fontSize:"0.82rem",marginBottom:"10px",fontWeight:700,
          wordBreak:"break-all"}}>{err}</div>}
        <Btn onClick={go} loading={loading}
          style={{width:"100%",justifyContent:"center"}}>Sign In</Btn>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:"14px"}}>
          <button onClick={onForgot} style={{background:"none",border:"none",
            color:C.timber,fontFamily:"inherit",fontSize:"0.82rem",fontWeight:700,
            cursor:"pointer",textDecoration:"underline"}}>Forgot Password?</button>
          <button onClick={onRegister} style={{background:"none",border:"none",
            color:C.sage,fontFamily:"inherit",fontSize:"0.82rem",fontWeight:700,
            cursor:"pointer",textDecoration:"underline"}}>Register (Dept Head)</button>
        </div>
      </div>
    </div>
  );
}

function RegisterScreen({onBack}){
  const [toastEl,showToast]=useToast();
  const [f,setF]=useState({name:"",dept:"",username:"",password:"",confirm:""});
  const [loading,setLoading]=useState(false);
  const ff=(k,v)=>setF({...f,[k]:v});
  const submit=async()=>{
    if(!f.name||!f.dept||!f.username||!f.password)
      return showToast("All fields required","warn");
    if(f.password!==f.confirm) return showToast("Passwords don't match","warn");
    if(f.password.length<6) return showToast("Password min 6 characters","warn");
    const uname=f.username.trim().toLowerCase();
    setLoading(true);
    try {
      const existing=await getDoc(doc(db,"users",uname));
      if(existing.exists()){
        showToast("Username already taken","danger"); setLoading(false); return;
      }
      const pwdHash=await hashPwd(f.password);
      await setDoc(doc(db,"users",uname),{
        id:uname,username:uname,name:f.name,dept:f.dept,
        role:"dept",approved:false,pwdHash,createdAt:serverTimestamp()
      });
      showToast("✅ Registered! Waiting for admin approval.");
      setTimeout(onBack,2500);
    } catch(e){ showToast("Failed: "+e.message,"danger"); setLoading(false); }
  };
  return(
    <div style={{minHeight:"100vh",
      background:`linear-gradient(160deg,${C.forest},${C.bark} 60%,${C.timber})`,
      display:"flex",alignItems:"center",justifyContent:"center",
      padding:"24px",fontFamily:"inherit"}}>
      {toastEl}
      <div style={{background:C.white,borderRadius:"20px",padding:"24px",
        width:"100%",maxWidth:"340px",boxShadow:"0 8px 40px rgba(0,0,0,0.4)"}}>
        <button onClick={onBack} style={{background:"none",border:"none",
          color:C.timber,fontFamily:"inherit",fontWeight:700,cursor:"pointer",
          marginBottom:"12px",fontSize:"0.88rem"}}>← Back to Login</button>
        <h2 style={{color:C.forest,marginTop:0,marginBottom:"18px",
          fontSize:"1.1rem",fontWeight:800}}>Department Head Registration</h2>
        <Inp label="Full Name *" value={f.name}
          onChange={e=>ff("name",e.target.value)} placeholder="Kofi Mensah"/>
        <Sel label="Department *" value={f.dept} onChange={e=>ff("dept",e.target.value)}>
          <option value="">Select department…</option>
          {DEPTS.map(d=><option key={d}>{d}</option>)}
        </Sel>
        <Inp label="Username *" value={f.username}
          onChange={e=>ff("username",e.target.value)}
          placeholder="firstname.lastname" autoCapitalize="none"/>
        <Inp label="Password *" type="password" value={f.password}
          onChange={e=>ff("password",e.target.value)} placeholder="Min 6 characters"/>
        <Inp label="Confirm Password *" type="password" value={f.confirm}
          onChange={e=>ff("confirm",e.target.value)}/>
        <Btn onClick={submit} loading={loading}
          style={{width:"100%",justifyContent:"center"}}>Register</Btn>
        <div style={{marginTop:"10px",padding:"8px",background:"#fff8e7",
          borderRadius:"8px",fontSize:"0.72rem",color:C.timber,lineHeight:1.6}}>
          ⚠ Account needs Abraham's approval before you can sign in.
        </div>
      </div>
    </div>
  );
}

function ForgotScreen({onBack}){
  const [toastEl,showToast]=useToast();
  const [username,setUsername]=useState("");
  const [loading,setLoading]=useState(false);
  const [sent,setSent]=useState(false);
  const submit=async()=>{
    if(!username.trim()){ showToast("Enter your username","warn"); return; }
    setLoading(true);
    const uname=username.trim().toLowerCase();
    try {
      const snap=await getDoc(doc(db,"users",uname));
      if(!snap.exists()){ showToast("Username not found","danger"); setLoading(false); return; }
      const data=snap.data();
      await addDoc(collection(db,"passwordResets"),{
        userId:uname,username:uname,name:data.name,dept:data.dept,
        status:"pending",requestedAt:serverTimestamp()
      });
      setSent(true);
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };
  return(
    <div style={{minHeight:"100vh",
      background:`linear-gradient(160deg,${C.forest},${C.bark} 60%,${C.timber})`,
      display:"flex",alignItems:"center",justifyContent:"center",
      padding:"24px",fontFamily:"inherit"}}>
      {toastEl}
      <div style={{background:C.white,borderRadius:"20px",padding:"24px",
        width:"100%",maxWidth:"340px",boxShadow:"0 8px 40px rgba(0,0,0,0.4)"}}>
        <button onClick={onBack} style={{background:"none",border:"none",
          color:C.timber,fontFamily:"inherit",fontWeight:700,cursor:"pointer",
          marginBottom:"12px",fontSize:"0.88rem"}}>← Back to Login</button>
        <h2 style={{color:C.forest,marginTop:0,marginBottom:"8px",
          fontSize:"1.1rem",fontWeight:800}}>Reset Password</h2>
        {sent?(
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:"3rem",marginBottom:"12px"}}>✅</div>
            <div style={{fontWeight:700,color:C.forest,marginBottom:"8px"}}>Request Sent!</div>
            <div style={{fontSize:"0.85rem",color:"#888",marginBottom:"16px"}}>
              Abraham will reset your password. Check back soon.</div>
            <Btn onClick={onBack} style={{width:"100%",justifyContent:"center"}}>
              Back to Login</Btn>
          </div>
        ):(
          <>
            <div style={{fontSize:"0.85rem",color:"#888",marginBottom:"16px"}}>
              Enter your username. Admin will set a new password.</div>
            <Inp label="Username *" value={username}
              onChange={e=>setUsername(e.target.value)}
              placeholder="your.username" autoCapitalize="none"/>
            <Btn onClick={submit} loading={loading}
              style={{width:"100%",justifyContent:"center"}}>Send Request</Btn>
          </>
        )}
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({user,onNav}){
  const [toastEl,showToast]=useToast();
  const [stats,setStats]=useState({lubes:0,items:0,pending:0,unread:0,
    pwdResets:0,lowLubes:[],lowItems:[]});
  const [lubes,setLubes]=useState([]);
  const [qf,setQf]=useState({lubeId:"",qty:"",takenBy:"",equipment:""});
  const [loading,setLoading]=useState(false);

  useEffect(()=>{
    const uL=onSnapshot(collection(db,"lubricants"),s=>{
      const ls=s.docs.map(d=>({id:d.id,...d.data()}));
      setLubes(ls);
      setStats(p=>({...p,lubes:ls.length,
        lowLubes:ls.filter(l=>(l.currentStock||0)<(l.minStock||0))}));
    });
    const uI=onSnapshot(collection(db,"storeItems"),s=>{
      setStats(p=>({...p,items:s.size,
        lowItems:s.docs.filter(d=>(d.data().currentStock||0)<(d.data().minStock||0))
          .map(d=>({id:d.id,...d.data()}))}));
    });
    const uR=onSnapshot(query(collection(db,"requisitions"),
      where("status","==","pending")),s=>setStats(p=>({...p,pending:s.size})));
    const uP=onSnapshot(query(collection(db,"passwordResets"),
      where("status","==","pending")),s=>setStats(p=>({...p,pwdResets:s.size})));

    // v8.3 FIX: read unread count from Firestore chats — RTDB is stale/unused
    // Track per-dept unread in a plain object outside state to avoid stale closure
    const deptUnreadMap={};
    const chatUnsubs=DEPTS.map(dept=>{
      return onSnapshot(
        query(collection(db,"chats",dept,"messages")),
        snap=>{
          deptUnreadMap[dept]=snap.docs.filter(d=>
            d.data().from!=="admin"&&!d.data().read
          ).length;
          const total=Object.values(deptUnreadMap).reduce((s,n)=>s+n,0);
          setStats(p=>({...p,unread:total}));
        },()=>{ deptUnreadMap[dept]=0; });
    });
    return()=>{uL();uI();uR();uP();chatUnsubs.forEach(u=>u());};
  },[user]);

  const quickIssue=async()=>{
    if(!qf.lubeId||!qf.qty||!qf.takenBy)
      return showToast("Lubricant, quantity and taken-by required","warn");
    const qty=parseFloat(qf.qty);
    if(qty<=0||isNaN(qty)) return showToast("Invalid quantity","warn");
    const lube=lubes.find(l=>l.id===qf.lubeId);
    if(!lube) return;
    setLoading(true);
    try {
      const lubeRef=doc(db,"lubricants",qf.lubeId);
      await runTransaction(db,async(tx)=>{
        const snap=await tx.get(lubeRef);
        if(!snap.exists()) throw new Error("Lubricant not found");
        const current=snap.data().currentStock||0;
        if(current<qty) throw new Error(`Not enough stock! Only ${current} ${snap.data().unit} left.`);
        tx.update(lubeRef,{currentStock:increment(-qty)});
      });
      await addDoc(collection(db,"transactions"),{
        type:"lube",action:"issue",itemId:qf.lubeId,itemName:lube.name,
        qty,unit:lube.unit,takenBy:qf.takenBy,equipment:qf.equipment||"",
        issuedBy:user?.name||"Unknown",date:today(),createdAt:serverTimestamp()
      });
      showToast("✅ Issued!");
      setQf({lubeId:"",qty:"",takenBy:"",equipment:""});
    } catch(e){ showToast(e.message||"Failed","danger"); }
    setLoading(false);
  };

  if(user.role==="dept") return <DeptDashboard user={user} onNav={onNav}/>;
  if(user.role==="hr"||user.dept==="HR") return <HRDashboard user={user} onNav={onNav}/>;

  const dStr=new Date().toLocaleDateString("en-GB",
    {weekday:"long",day:"numeric",month:"long"});
  return(
    <div style={{padding:"0 12px 80px"}}>
      {toastEl}
      <div style={{background:`linear-gradient(135deg,${C.forest},${C.bark})`,
        padding:"18px 16px 22px",borderRadius:"0 0 22px 22px",margin:"0 -12px 14px"}}>
        <div style={{fontSize:"0.7rem",color:"rgba(245,237,214,0.55)",
          textTransform:"uppercase",letterSpacing:"0.1em"}}>{dStr}</div>
        <div style={{fontSize:"1.2rem",color:C.cream,fontWeight:800,marginTop:"2px"}}>
          Hello, {getFirstName(user)} 👋</div>
        <div style={{fontSize:"0.78rem",color:"rgba(245,237,214,0.65)",marginTop:"2px"}}>
          System Administrator · Stores Manager</div>
      </div>
      {stats.pwdResets>0&&(
        <div style={{background:"#fff8e7",border:`1.5px solid ${C.gold}`,
          borderRadius:"12px",padding:"12px",marginBottom:"10px"}}>
          <div style={{fontWeight:800,color:C.gold,fontSize:"0.88rem"}}>
            🔑 {stats.pwdResets} Password Reset Request{stats.pwdResets>1?"s":""}</div>
          <button onClick={()=>onNav("settings")} style={{background:"none",border:"none",
            color:C.timber,fontFamily:"inherit",fontWeight:700,fontSize:"0.8rem",
            cursor:"pointer",textDecoration:"underline",padding:"4px 0"}}>
            Handle in Settings →</button>
        </div>
      )}
      {(stats.lowLubes.length>0||stats.lowItems.length>0)&&(
        <div style={{background:"#fff8e7",border:`1.5px solid ${C.gold}`,
          borderRadius:"12px",padding:"12px",marginBottom:"10px"}}>
          <div style={{fontWeight:800,color:C.gold,marginBottom:"6px",
            fontSize:"0.88rem"}}>⚠ Restock Alerts</div>
          {stats.lowLubes.map(l=><div key={l.id} style={{fontSize:"0.8rem",
            color:C.bark,padding:"2px 0"}}>
            🛢 {l.name}: <strong>{l.currentStock||0} {l.unit}</strong> (min {l.minStock})
          </div>)}
          {stats.lowItems.map(i=><div key={i.id} style={{fontSize:"0.8rem",
            color:C.bark,padding:"2px 0"}}>
            📦 {i.name}: <strong>{i.currentStock||0}</strong> (min {i.minStock})
          </div>)}
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",
        marginBottom:"10px"}}>
        {[
          {icon:"🛢",l:"Lubricants",v:stats.lubes,s:`${stats.lowLubes.length} low`,c:C.timber},
          {icon:"📦",l:"Store Items",v:stats.items,s:`${stats.lowItems.length} low`,c:C.sage},
          {icon:"📋",l:"Pending Reqs",v:stats.pending,s:"awaiting approval",
            c:stats.pending>0?C.warn:C.ok,action:()=>onNav("reqs")},
          {icon:"💬",l:"Unread Chats",v:stats.unread,s:"from departments",
            c:stats.unread>0?C.warn:C.ok,action:()=>onNav("chat")},
        ].map((s,i)=>(
          <Card key={i} style={{marginBottom:0,cursor:s.action?"pointer":"default"}}
            onClick={s.action}>
            <div style={{fontSize:"1.6rem",marginBottom:"2px"}}>{s.icon}</div>
            <div style={{fontSize:"1.6rem",fontWeight:800,color:s.c,lineHeight:1}}>
              {s.v}</div>
            <div style={{fontSize:"0.72rem",fontWeight:700,color:C.timber,
              textTransform:"uppercase",marginTop:"2px"}}>{s.l}</div>
            <div style={{fontSize:"0.65rem",color:"#aaa"}}>{s.s}</div>
          </Card>
        ))}
      </div>
      <Card>
        <div style={{fontWeight:800,color:C.forest,marginBottom:"10px",
          fontSize:"0.95rem"}}>⚡ Quick Issue — Lubricant</div>
        <Sel label="Lubricant *" value={qf.lubeId}
          onChange={e=>setQf({...qf,lubeId:e.target.value})}>
          <option value="">Select…</option>
          {lubes.map(l=><option key={l.id} value={l.id}>
            {l.name} ({l.currentStock||0} {l.unit})</option>)}
        </Sel>
        <div style={{display:"flex",gap:"8px"}}>
          <Inp label="Qty *" type="number" value={qf.qty}
            onChange={e=>setQf({...qf,qty:e.target.value})} wrapStyle={{flex:1}}/>
          <Inp label="Taken By *" value={qf.takenBy}
            onChange={e=>setQf({...qf,takenBy:e.target.value})} wrapStyle={{flex:2}}/>
        </div>
        <Inp label="Equipment" value={qf.equipment}
          onChange={e=>setQf({...qf,equipment:e.target.value})}
          placeholder="e.g. Generator A"/>
        <Btn onClick={quickIssue} loading={loading}
          style={{width:"100%",justifyContent:"center"}}>Issue Now</Btn>
      </Card>
    </div>
  );
}

function DeptDashboard({user,onNav}){
  const [reqs,setReqs]=useState([]);
  const [unread,setUnread]=useState(0);
  useEffect(()=>{
    const uR=onSnapshot(query(collection(db,"requisitions"),
      where("dept","==",user.dept)),
      s=>{
        const all=s.docs.map(d=>({id:d.id,...d.data()}));
        all.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
        setReqs(all);
      },()=>{});
    // v8.3 FIX: read unread from Firestore chats (messages from admin not yet read)
    const uChat=onSnapshot(
      query(collection(db,"chats",user.dept,"messages")),
      snap=>{
        const u=snap.docs.filter(d=>
          d.data().from==="admin"&&!d.data().read
        ).length;
        setUnread(u);
      },()=>setUnread(0));
    return()=>{uR();uChat();};
  },[user]);
  return(
    <div style={{padding:"0 12px 80px"}}>
      <div style={{background:`linear-gradient(135deg,${C.forest},${C.bark})`,
        padding:"18px 16px 22px",borderRadius:"0 0 22px 22px",margin:"0 -12px 14px"}}>
        <div style={{fontSize:"1.2rem",color:C.cream,fontWeight:800}}>
          Hello, {getFirstName(user)} 👋</div>
        <div style={{fontSize:"0.78rem",color:"rgba(245,237,214,0.65)",marginTop:"2px"}}>
          {user.dept} · Department Head</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginBottom:"12px"}}>
        {[
          {icon:"📋",l:"My Requests",v:reqs.length,
            s:`${reqs.filter(r=>r.status==="pending").length} pending`,c:C.timber},
          {icon:"✅",l:"Approved",v:reqs.filter(r=>r.status==="approved").length,
            s:"requests",c:C.ok},
          {icon:"💬",l:"Messages",v:unread,s:unread>0?"from admin":"no new",
            c:unread>0?C.warn:C.sage,action:()=>onNav("chat")},
          {icon:"📅",l:"Attendance",v:"→",s:"mark today",c:C.blue,
            action:()=>onNav("attendance")},
        ].map((s,i)=>(
          <Card key={i} style={{marginBottom:0,cursor:s.action?"pointer":"default"}}
            onClick={s.action}>
            <div style={{fontSize:"1.6rem",marginBottom:"2px"}}>{s.icon}</div>
            <div style={{fontSize:"1.6rem",fontWeight:800,color:s.c,lineHeight:1}}>
              {s.v}</div>
            <div style={{fontSize:"0.72rem",fontWeight:700,color:C.timber,
              textTransform:"uppercase",marginTop:"2px"}}>{s.l}</div>
            <div style={{fontSize:"0.65rem",color:"#aaa"}}>{s.s}</div>
          </Card>
        ))}
      </div>
      <Card>
        <div style={{fontWeight:800,color:C.forest,marginBottom:"8px"}}>Quick Actions</div>
        <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
          <Btn sm onClick={()=>onNav("reqs")} style={{flex:1,justifyContent:"center"}}>
            + New Request</Btn>
          <Btn sm onClick={()=>onNav("attendance")} color={C.blue}
            style={{flex:1,justifyContent:"center"}}>📅 Attendance</Btn>
          <Btn sm onClick={()=>onNav("chat")} color={C.sage}
            style={{flex:1,justifyContent:"center"}}>
            💬 Chat{unread>0?` (${unread})`:""}</Btn>
        </div>
      </Card>
    </div>
  );
}

function HRDashboard({user,onNav}){
  const [p,setP]=useState({chop:0,att:0,workers:0});
  useEffect(()=>{
    const uC=onSnapshot(query(collection(db,"chopMoney"),where("status","==","pending")),
      s=>setP(x=>({...x,chop:s.size})));
    const uA=onSnapshot(query(collection(db,"attendanceReports"),where("status","==","pending")),
      s=>setP(x=>({...x,att:s.size})));
    const uW=onSnapshot(collection(db,"workers"),
      s=>setP(x=>({...x,workers:s.size})));
    return()=>{uC();uA();uW();};
  },[]);
  return(
    <div style={{padding:"0 12px 80px"}}>
      <div style={{background:`linear-gradient(135deg,${C.forest},${C.bark})`,
        padding:"18px 16px 22px",borderRadius:"0 0 22px 22px",margin:"0 -12px 14px"}}>
        <div style={{fontSize:"1.2rem",color:C.cream,fontWeight:800}}>
          Hello, {getFirstName(user)} 👋</div>
        <div style={{fontSize:"0.78rem",color:"rgba(245,237,214,0.65)",marginTop:"2px"}}>
          HR Department</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginBottom:"12px"}}>
        {[
          {icon:"💰",l:"Chop Money",v:p.chop,s:"pending approval",c:p.chop>0?C.warn:C.ok,action:()=>onNav("hr")},
          {icon:"📅",l:"Attendance",v:p.att,s:"pending reports",c:p.att>0?C.warn:C.ok,action:()=>onNav("hr")},
          {icon:"👥",l:"Staff Roster",v:p.workers,s:"total workers",c:C.sage,action:()=>onNav("hr")},
          {icon:"💬",l:"Chat Admin",v:"→",s:"direct line",c:C.blue,action:()=>onNav("chat")},
        ].map((s,i)=>(
          <Card key={i} style={{marginBottom:0,cursor:"pointer"}} onClick={s.action}>
            <div style={{fontSize:"1.6rem",marginBottom:"2px"}}>{s.icon}</div>
            <div style={{fontSize:"1.6rem",fontWeight:800,color:s.c,lineHeight:1}}>{s.v}</div>
            <div style={{fontSize:"0.72rem",fontWeight:700,color:C.timber,
              textTransform:"uppercase",marginTop:"2px"}}>{s.l}</div>
            <div style={{fontSize:"0.65rem",color:"#aaa"}}>{s.s||""}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── LUBRICANTS ───────────────────────────────────────────────────────────────
function LubesModule({user}){
  const [tab,setTab]=useState("stock");
  const [lubes,setLubes]=useState([]);
  const [txs,setTxs]=useState([]);
  const [modal,setModal]=useState(null);
  const [toastEl,showToast]=useToast();
  const [fDept,setFDept]=useState("");
  const [fFrom,setFFrom]=useState("");
  const [fTo,setFTo]=useState("");
  const [form,setForm]=useState({lubeId:"",qty:"",takenBy:"",equipment:"",desc:""});
  const [loading,setLoading]=useState(false);

  useEffect(()=>{
    const uL=onSnapshot(collection(db,"lubricants"),
      s=>setLubes(s.docs.map(d=>({id:d.id,...d.data()}))));
    const uT=onSnapshot(query(collection(db,"transactions"),
      where("type","==","lube")),
      s=>{ const all=s.docs.map(d=>({id:d.id,...d.data()}));
           all.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
           setTxs(all); });
    return()=>{uL();uT();};
  },[]);

  const doTx=async(action)=>{
    if(!form.lubeId||!form.qty) return showToast("Select lubricant and enter quantity","warn");
    if(action==="issue"&&!form.takenBy) return showToast("Enter who is taking the lubricant","warn");
    const qty=parseFloat(form.qty);
    if(qty<=0||isNaN(qty)) return showToast("Invalid quantity","warn");
    const lube=lubes.find(l=>l.id===form.lubeId);
    if(!lube) return;
    setLoading(true);
    try {
      const lubeRef=doc(db,"lubricants",form.lubeId);
      await runTransaction(db,async(tx)=>{
        const snap=await tx.get(lubeRef);
        if(!snap.exists()) throw new Error("Lubricant not found");
        const current=snap.data().currentStock||0;
        if(action==="issue"&&current<qty)
          throw new Error(`Not enough stock! Only ${current} ${snap.data().unit} left.`);
        tx.update(lubeRef,{currentStock:increment(action==="restock"?qty:-qty)});
      });
      await addDoc(collection(db,"transactions"),{
        type:"lube",action,itemId:form.lubeId,itemName:lube.name,
        qty,unit:lube.unit,takenBy:form.takenBy||"",
        equipment:form.equipment||"",desc:form.desc||"",
        issuedBy:user?.name||"Unknown",date:today(),createdAt:serverTimestamp()
      });
      showToast(action==="issue"?"✅ Issued!":"✅ Restocked!");
      setForm({lubeId:"",qty:"",takenBy:"",equipment:"",desc:""});
    } catch(e){ showToast(e.message||"Failed","danger"); }
    setLoading(false);
  };

  const deleteTx=async(tx)=>{
    if(!window.confirm("Delete this transaction? Stock will be reversed.")) return;
    try {
      const lubeRef=doc(db,"lubricants",tx.itemId);
      await runTransaction(db,async(t)=>{
        const snap=await t.get(lubeRef);
        if(snap.exists())
          t.update(lubeRef,{currentStock:increment(tx.action==="issue"?tx.qty:-tx.qty)});
      });
      await deleteDoc(doc(db,"transactions",tx.id));
      showToast("Deleted and stock reversed.");
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
  };

  const ftx=txs.filter(t=>
    (!fDept||t.dept===fDept)&&
    (!fFrom||tsToStr(t.createdAt)>=fFrom)&&
    (!fTo||tsToStr(t.createdAt)<=fTo));

  return(
    <div style={{padding:"0 12px 80px"}}>
      {toastEl}
      <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest,
        marginBottom:"12px",paddingTop:"4px"}}>🛢 Lubricants Store</div>
      <TabBar tabs={[{id:"stock",label:"Stock"},{id:"issue",label:"Issue"},
        {id:"restock",label:"Restock"},{id:"log",label:"Log"}]}
        active={tab} onSelect={setTab}/>

      {tab==="stock"&&(
        <div>
          {lubes.length===0&&<div style={{textAlign:"center",color:"#aaa",padding:"30px"}}>
            No lubricants. Go to Settings → Setup → Add Default Lubricants.</div>}
          {lubes.map(l=>{
            const low=(l.currentStock||0)<(l.minStock||0);
            return(
              <Card key={l.id} style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"8px"}}>
                <div style={{fontSize:"1.8rem"}}>🛢</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,color:C.forest}}>{l.name}</div>
                  <div style={{fontSize:"0.75rem",color:"#888"}}>{l.unit} · Min: {l.minStock}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:"1.5rem",fontWeight:800,
                    color:low?C.danger:C.ok,lineHeight:1}}>{l.currentStock||0}</div>
                  <Badge color={low?C.danger:C.ok}>{low?"LOW":"OK"}</Badge>
                </div>
              </Card>
            );
          })}
          <Btn onClick={()=>setModal("add")}
            style={{width:"100%",justifyContent:"center",marginTop:"4px"}}>
            + Add Lubricant</Btn>
        </div>
      )}

      {(tab==="issue"||tab==="restock")&&(
        <Card>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"10px"}}>
            {tab==="issue"?"Issue Lubricant":"Restock Lubricant"}</div>
          <Sel label="Lubricant *" value={form.lubeId}
            onChange={e=>setForm({...form,lubeId:e.target.value})}>
            <option value="">Select…</option>
            {lubes.map(l=><option key={l.id} value={l.id}>
              {l.name} ({l.currentStock||0} {l.unit})</option>)}
          </Sel>
          <Inp label={tab==="issue"?"Quantity *":"Quantity Received *"}
            type="number" value={form.qty}
            onChange={e=>setForm({...form,qty:e.target.value})}/>
          {tab==="issue"&&<>
            <Inp label="Taken By *" value={form.takenBy}
              onChange={e=>setForm({...form,takenBy:e.target.value})}
              placeholder="Name of person collecting"/>
            <Inp label="Equipment (optional)" value={form.equipment}
              onChange={e=>setForm({...form,equipment:e.target.value})}
              placeholder="e.g. Generator A"/>
          </>}
          {tab==="restock"&&
            <Inp label="Supplier / Note (optional)" value={form.desc}
              onChange={e=>setForm({...form,desc:e.target.value})}
              placeholder="e.g. Delivered from Accra"/>}
          <Btn onClick={()=>doTx(tab)} loading={loading}
            style={{width:"100%",justifyContent:"center"}}>
            {tab==="issue"?"Issue":"Restock"}</Btn>
        </Card>
      )}

      {tab==="log"&&(
        <div>
          <div style={{display:"flex",gap:"6px",marginBottom:"10px",flexWrap:"wrap"}}>
            <select value={fDept} onChange={e=>setFDept(e.target.value)}
              style={{flex:1,minWidth:"100px",padding:"8px",
                border:`1.5px solid ${C.border}`,borderRadius:"8px",
                fontFamily:"inherit",fontSize:"0.85rem",background:C.white}}>
              <option value="">All Depts</option>
              {DEPTS.map(d=><option key={d}>{d}</option>)}
            </select>
            <input type="date" value={fFrom} onChange={e=>setFFrom(e.target.value)}
              style={{flex:1,padding:"8px",border:`1.5px solid ${C.border}`,borderRadius:"8px",fontSize:"0.85rem"}}/>
            <input type="date" value={fTo} onChange={e=>setFTo(e.target.value)}
              style={{flex:1,padding:"8px",border:`1.5px solid ${C.border}`,borderRadius:"8px",fontSize:"0.85rem"}}/>
          </div>
          {ftx.length===0&&<div style={{textAlign:"center",color:"#aaa",padding:"30px"}}>No records.</div>}
          {ftx.map(t=>(
            <Card key={t.id} style={{borderLeft:`4px solid ${t.action==="issue"?C.warn:C.ok}`,marginBottom:"8px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{fontWeight:800,color:C.forest}}>{t.itemName}</div>
                  <div style={{fontSize:"0.75rem",color:"#888"}}>
                    {fmtDate(t.createdAt)} · {t.takenBy||"restocked"}</div>
                  {t.equipment&&<div style={{fontSize:"0.75rem",color:"#999"}}>🔧 {t.equipment}</div>}
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:"4px"}}>
                  <div style={{fontSize:"1.2rem",fontWeight:800,
                    color:t.action==="issue"?C.warn:C.ok}}>
                    {t.action==="issue"?"-":"+"}{t.qty} {t.unit}</div>
                  <Badge color={t.action==="issue"?C.warn:C.ok}>
                    {t.action==="issue"?"ISSUED":"IN"}</Badge>
                  {user.role==="admin"&&(
                    <button onClick={()=>deleteTx(t)} style={{background:"none",
                      border:"none",color:C.danger,cursor:"pointer",fontSize:"0.72rem",fontWeight:700}}>
                      🗑 Delete</button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {modal==="add"&&<Modal title="Add Lubricant" onClose={()=>setModal(null)}>
        <AddLubeForm onSave={async(f)=>{
          if(!f.name) return;
          await addDoc(collection(db,"lubricants"),{
            name:f.name,unit:f.unit||"Litres",
            minStock:parseFloat(f.minStock)||0,currentStock:0,
            createdAt:serverTimestamp()
          });
          showToast("✅ Added!"); setModal(null);
        }}/>
      </Modal>}
    </div>
  );
}
function AddLubeForm({onSave}){
  const [f,setF]=useState({name:"",unit:"Litres",minStock:"50"});
  return(<div>
    <Inp label="Name *" value={f.name} onChange={e=>setF({...f,name:e.target.value})}/>
    <Sel label="Unit" value={f.unit} onChange={e=>setF({...f,unit:e.target.value})}>
      <option>Litres</option><option>Gallons</option><option>Kg</option>
    </Sel>
    <Inp label="Min Stock Alert" type="number" value={f.minStock}
      onChange={e=>setF({...f,minStock:e.target.value})}/>
    <Btn onClick={()=>onSave(f)} style={{width:"100%",justifyContent:"center"}}>Save</Btn>
  </div>);
}

// ─── GENERAL STORES ───────────────────────────────────────────────────────────
function StoresModule({user}){
  const [tab,setTab]=useState("stock");
  const [items,setItems]=useState([]);
  const [txs,setTxs]=useState([]);
  const [modal,setModal]=useState(null);
  const [toastEl,showToast]=useToast();
  const [search,setSearch]=useState("");
  const [form,setForm]=useState({itemId:"",qty:"",takenBy:"",dept:"",desc:""});
  const [loading,setLoading]=useState(false);

  useEffect(()=>{
    const uI=onSnapshot(collection(db,"storeItems"),
      s=>setItems(s.docs.map(d=>({id:d.id,...d.data()}))));
    const uT=onSnapshot(query(collection(db,"transactions"),
      where("type","==","store")),
      s=>{ const all=s.docs.map(d=>({id:d.id,...d.data()}));
           all.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
           setTxs(all); });
    return()=>{uI();uT();};
  },[]);

  const doTx=async(action)=>{
    if(!form.itemId||!form.qty) return showToast("Select item and enter quantity","warn");
    if(action==="issue"&&(!form.takenBy||!form.dept))
      return showToast("Taken-by and department required","warn");
    const qty=parseFloat(form.qty);
    if(qty<=0||isNaN(qty)) return showToast("Invalid quantity","warn");
    const item=items.find(i=>i.id===form.itemId);
    if(!item) return;
    setLoading(true);
    try {
      const itemRef=doc(db,"storeItems",form.itemId);
      await runTransaction(db,async(tx)=>{
        const snap=await tx.get(itemRef);
        if(!snap.exists()) throw new Error("Item not found");
        const current=snap.data().currentStock||0;
        if(action==="issue"&&current<qty)
          throw new Error(`Not enough stock! Only ${current} ${snap.data().unit||"pcs"} left.`);
        tx.update(itemRef,{currentStock:increment(action==="restock"?qty:-qty)});
      });
      await addDoc(collection(db,"transactions"),{
        type:"store",action,itemId:form.itemId,itemName:item.name,
        qty,unit:item.unit||"pcs",takenBy:form.takenBy||"",
        dept:form.dept||"",desc:form.desc||"",
        issuedBy:user?.name||"Unknown",date:today(),createdAt:serverTimestamp()
      });
      showToast(action==="issue"?"✅ Issued!":"✅ Restocked!");
      setForm({itemId:"",qty:"",takenBy:"",dept:"",desc:""});
    } catch(e){ showToast(e.message||"Failed","danger"); }
    setLoading(false);
  };

  const deleteTx=async(tx)=>{
    if(!window.confirm("Delete? Stock will be reversed.")) return;
    try {
      const itemRef=doc(db,"storeItems",tx.itemId);
      await runTransaction(db,async(t)=>{
        const snap=await t.get(itemRef);
        if(snap.exists())
          t.update(itemRef,{currentStock:increment(tx.action==="issue"?tx.qty:-tx.qty)});
      });
      await deleteDoc(doc(db,"transactions",tx.id));
      showToast("Deleted.");
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
  };

  const filtered=items.filter(i=>i.name.toLowerCase().includes(search.toLowerCase()));

  return(
    <div style={{padding:"0 12px 80px"}}>
      {toastEl}
      <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest,
        marginBottom:"12px",paddingTop:"4px"}}>📦 General Stores</div>
      <TabBar tabs={[{id:"stock",label:"Stock"},{id:"issue",label:"Issue"},
        {id:"restock",label:"Restock"},{id:"log",label:"Log"}]}
        active={tab} onSelect={setTab}/>

      {tab==="stock"&&(
        <div>
          <Inp value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search…"/>
          {filtered.map(i=>{
            const low=(i.currentStock||0)<(i.minStock||0);
            return(
              <Card key={i.id} style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"8px"}}>
                <div style={{fontSize:"1.8rem"}}>📦</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,color:C.forest}}>{i.name}</div>
                  <div style={{fontSize:"0.72rem",color:"#888"}}>
                    {i.unit||"pcs"} · {i.category||"General"} · Min:{i.minStock||0}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:"1.4rem",fontWeight:800,
                    color:low?C.danger:C.ok,lineHeight:1}}>{i.currentStock||0}</div>
                  <Badge color={low?C.danger:C.ok}>{low?"LOW":"OK"}</Badge>
                </div>
              </Card>
            );
          })}
          <Btn onClick={()=>setModal("add")}
            style={{width:"100%",justifyContent:"center",marginTop:"4px"}}>
            + Add Item</Btn>
        </div>
      )}

      {(tab==="issue"||tab==="restock")&&(
        <Card>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"10px"}}>
            {tab==="issue"?"Issue Item":"Restock Item"}</div>
          <Sel label="Item *" value={form.itemId}
            onChange={e=>setForm({...form,itemId:e.target.value})}>
            <option value="">Select…</option>
            {items.map(i=><option key={i.id} value={i.id}>
              {i.name} ({i.currentStock||0} {i.unit||"pcs"})</option>)}
          </Sel>
          <Inp label={tab==="issue"?"Quantity *":"Quantity Received *"}
            type="number" value={form.qty}
            onChange={e=>setForm({...form,qty:e.target.value})}/>
          {tab==="issue"&&<>
            <Inp label="Taken By *" value={form.takenBy}
              onChange={e=>setForm({...form,takenBy:e.target.value})} placeholder="Name of person"/>
            <Sel label="Department *" value={form.dept}
              onChange={e=>setForm({...form,dept:e.target.value})}>
              <option value="">Select department…</option>
              {DEPTS.map(d=><option key={d}>{d}</option>)}
            </Sel>
          </>}
          {tab==="restock"&&
            <Inp label="Supplier / Note (optional)" value={form.desc}
              onChange={e=>setForm({...form,desc:e.target.value})}
              placeholder="e.g. Delivered from supplier"/>}
          <Btn onClick={()=>doTx(tab)} loading={loading}
            style={{width:"100%",justifyContent:"center"}}>
            {tab==="issue"?"Issue":"Restock"}</Btn>
        </Card>
      )}

      {tab==="log"&&(
        txs.length===0
          ?<div style={{textAlign:"center",color:"#aaa",padding:"30px"}}>No transactions.</div>
          :txs.map(t=>(
            <Card key={t.id} style={{borderLeft:`4px solid ${t.action==="issue"?C.warn:C.ok}`,marginBottom:"8px"}}>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <div>
                  <div style={{fontWeight:800,color:C.forest}}>{t.itemName}</div>
                  <div style={{fontSize:"0.75rem",color:"#888"}}>
                    {fmtDate(t.createdAt)} · {t.dept} · {t.takenBy}</div>
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:"4px"}}>
                  <div style={{fontSize:"1.2rem",fontWeight:800,
                    color:t.action==="issue"?C.warn:C.ok}}>
                    {t.action==="issue"?"-":"+"}{t.qty}</div>
                  <Badge color={t.action==="issue"?C.warn:C.ok}>
                    {t.action==="issue"?"ISSUED":"IN"}</Badge>
                  {user.role==="admin"&&(
                    <button onClick={()=>deleteTx(t)} style={{background:"none",
                      border:"none",color:C.danger,cursor:"pointer",fontSize:"0.72rem",fontWeight:700}}>
                      🗑 Delete</button>
                  )}
                </div>
              </div>
            </Card>
          ))
      )}

      {modal==="add"&&<Modal title="Add Store Item" onClose={()=>setModal(null)}>
        <AddItemForm onSave={async(f)=>{
          if(!f.name) return;
          await addDoc(collection(db,"storeItems"),{
            name:f.name,unit:f.unit||"pcs",category:f.category||"General",
            minStock:parseFloat(f.minStock)||0,currentStock:0,
            createdAt:serverTimestamp()
          });
          showToast("✅ Added!"); setModal(null);
        }}/>
      </Modal>}
    </div>
  );
}
function AddItemForm({onSave}){
  const [f,setF]=useState({name:"",unit:"pcs",category:"General",minStock:"0"});
  return(<div>
    <Inp label="Item Name *" value={f.name} onChange={e=>setF({...f,name:e.target.value})}/>
    <div style={{display:"flex",gap:"8px"}}>
      <Sel label="Unit" value={f.unit} onChange={e=>setF({...f,unit:e.target.value})} wrapStyle={{flex:1}}>
        <option>pcs</option><option>Kg</option><option>Litres</option>
        <option>Bags</option><option>Rolls</option><option>Boxes</option>
      </Sel>
      <Inp label="Category" value={f.category}
        onChange={e=>setF({...f,category:e.target.value})} wrapStyle={{flex:1}}/>
    </div>
    <Inp label="Min Stock Alert" type="number" value={f.minStock}
      onChange={e=>setF({...f,minStock:e.target.value})}/>
    <Btn onClick={()=>onSave(f)} style={{width:"100%",justifyContent:"center"}}>Save</Btn>
  </div>);
}

// ─── REQUISITIONS v8.2.2 — SMART ROUTING ─────────────────────────────────────
function ReqsModule({user}){
  const [reqs,setReqs]=useState([]);
  const [modal,setModal]=useState(false);
  const [detail,setDetail]=useState(null);
  const [toastEl,showToast]=useToast();
  const [tab,setTab]=useState("pending");
  const [loading,setLoading]=useState(false);

  // v8.4 STRICT ROLES — use user.role only, never dept for authority
  const isAdmin = user.role === "admin";
  const isCOO   = user.role === "coo";
  const isHR    = user.role === "hr";

  // ROUTING RULE:
  // Admin creates → approverRole:"coo" → COO approves
  // Everyone else creates → approverRole:"admin" → Admin approves

  // WHAT EACH ROLE SEES:
  // Admin → only reqs with approverRole:"admin"
  // COO (Administration dept) → only reqs with approverRole:"coo"
  // HR/Dept → only their own submissions

  useEffect(()=>{
    let q;
    if(isAdmin)
      // No orderBy — avoids composite index. Sort client-side.
      q=query(collection(db,"requisitions"),where("approverRole","==","admin"));
    else if(isCOO)
      q=query(collection(db,"requisitions"),where("approverRole","==","coo"));
    else
      // Dept/HR see their dept's requests
      q=query(collection(db,"requisitions"),where("dept","==",user.dept));
    return onSnapshot(q,s=>{
      const all=s.docs.map(d=>({id:d.id,...d.data()}));
      // Sort client-side: newest first, no Firestore index needed
      all.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setReqs(all);
    },e=>console.log("Reqs:",e.message));
  },[user.role,user.dept,isAdmin,isCOO]);

  const submit=async(f)=>{
    if(!f.item||!f.qty) return showToast("Item and quantity required","warn");
    setLoading(true);
    try {
      // KEY ROUTING LOGIC: Admin's requests go to COO, everyone else goes to Admin
      const approverRole=isAdmin?"coo":"admin";
      await addDoc(collection(db,"requisitions"),{
        ...f,
        dept:user.dept,
        requestedBy:user?.name||user?.username||"Unknown",
        userId:user.id,
        approverRole,
        status:"pending",
        createdAt:serverTimestamp()
      });
      const dest=isAdmin?"Administration (COO)":"Stores Manager";
      showToast(`✅ Request submitted to ${dest}!`);
      setModal(false);
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };

  const approveReq=async(id,req)=>{
    if(req.approverRole==="admin"&&!isAdmin)
      return showToast("Only Stores Admin can approve this request","danger");
    if(req.approverRole==="coo"&&!isCOO)
      return showToast("Only COO (Administration) can approve this request","danger");
    try {
      await updateDoc(doc(db,"requisitions",id),{
        status:"approved",
        approvedBy:user?.name||user?.username||"Unknown",
        approvedRole:req.approverRole,
        approvedAt:serverTimestamp()
      });
      // History log
      await addDoc(collection(db,"requisitionHistory"),{
        reqId:id,item:req.item,dept:req.dept,
        action:"approved",by:user?.name||"Unknown",
        role:user?.role||"",time:serverTimestamp()
      });
      // Notify requester
      await sendNotification(db,user,req.dept,req.userId,req.requestedBy,
        "requisition",`✅ ${req.item} approved by ${user?.name||"Admin"}`,
        {reqId:id,status:"approved"});
      showToast("✅ Approved!"); setDetail(null);
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
  };

  const rejectReq=async(id,req,note="")=>{
    if(req.approverRole==="admin"&&!isAdmin)
      return showToast("Only Stores Admin can reject this request","danger");
    if(req.approverRole==="coo"&&!isCOO)
      return showToast("Only COO (Administration) can reject this request","danger");
    try {
      await updateDoc(doc(db,"requisitions",id),{
        status:"rejected",
        rejectedBy:user?.name||user?.username||"Unknown",
        rejectedRole:req.approverRole,
        adminNote:note,
        rejectedAt:serverTimestamp()
      });
      // History log
      await addDoc(collection(db,"requisitionHistory"),{
        reqId:id,item:req.item,dept:req.dept,
        action:"rejected",note,by:user?.name||"Unknown",
        role:user?.role||"",time:serverTimestamp()
      });
      // Notify requester
      await sendNotification(db,user,req.dept,req.userId,req.requestedBy,
        "requisition",`❌ ${req.item} rejected${note?` — ${note}`:""}`,
        {reqId:id,status:"rejected"});
      showToast("❌ Rejected"); setDetail(null);
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
  };

  // Can this user approve/reject the currently viewed request?
  const canDecide=(req)=>req&&req.status==="pending"&&(
    (req.approverRole==="admin"&&isAdmin)||
    (req.approverRole==="coo"&&isCOO)
  );

  const pending=reqs.filter(r=>r.status==="pending");
  const approved=reqs.filter(r=>r.status==="approved");
  const rejected=reqs.filter(r=>r.status==="rejected");
  const shown=tab==="pending"?pending:tab==="approved"?approved:rejected;

  return(
    <div style={{padding:"0 12px 80px"}}>
      {toastEl}
      <div style={{display:"flex",justifyContent:"space-between",
        alignItems:"center",marginBottom:"12px",paddingTop:"4px"}}>
        <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest}}>📋 Requisitions</div>
        <Btn sm onClick={()=>setModal(true)}>+ New</Btn>
      </div>

      {/* Role authority banners */}
      {isAdmin&&(
        <div style={{padding:"8px",background:"#e8f5e9",borderRadius:"8px",
          fontSize:"0.78rem",color:C.sage,marginBottom:"10px",fontWeight:700}}>
          👑 Admin — you approve department requests. Your own requests go to COO.</div>
      )}
      {isCOO&&(
        <div style={{padding:"8px",background:"#e3f2fd",borderRadius:"8px",
          fontSize:"0.78rem",color:C.blue,marginBottom:"10px",fontWeight:700}}>
          🏢 COO — you approve requests escalated from the Stores Admin.</div>
      )}
      {!isAdmin&&!isCOO&&(
        <div style={{padding:"8px",background:"#fff8e7",borderRadius:"8px",
          fontSize:"0.78rem",color:C.timber,marginBottom:"10px",fontWeight:700}}>
          📋 Submit requests to Stores Admin for approval.</div>
      )}

      <TabBar tabs={[
        {id:"pending",label:`Pending (${pending.length})`},
        {id:"approved",label:"Approved"},
        {id:"rejected",label:"Rejected"}
      ]} active={tab} onSelect={setTab}/>

      {shown.length===0&&<div style={{textAlign:"center",color:"#aaa",padding:"40px"}}>
        No {tab} requisitions.</div>}
      {shown.map(r=>(
        <Card key={r.id} style={{borderLeft:`4px solid ${
          r.status==="pending"?C.warn:r.status==="approved"?C.ok:C.danger}`,
          marginBottom:"8px",cursor:"pointer"}} onClick={()=>setDetail(r)}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <div style={{flex:1}}>
              <div style={{fontWeight:800,color:C.forest}}>{r.item}</div>
              <div style={{fontSize:"0.75rem",color:"#888"}}>
                {r.dept} · {fmtDate(r.createdAt)}</div>
              <div style={{fontSize:"0.78rem",color:C.timber}}>
                👤 {r.requestedBy} · {r.qty} {r.unit||""}</div>
              {/* Routing indicator */}
              <div style={{fontSize:"0.68rem",color:"#aaa",marginTop:"2px"}}>
                → {r.approverRole==="admin"?"Stores Admin":"COO (Administration)"}</div>
              {r.urgency&&r.urgency!=="normal"&&
                <Badge color={r.urgency==="critical"?C.danger:C.warn}>
                  {r.urgency.toUpperCase()}</Badge>}
            </div>
            <Badge color={r.status==="pending"?C.warn:r.status==="approved"?C.ok:C.danger}>
              {r.status.toUpperCase()}</Badge>
          </div>
        </Card>
      ))}

      {modal&&<Modal title="New Requisition" onClose={()=>setModal(false)}>
        <ReqForm onSubmit={submit} loading={loading} user={user} isAdmin={isAdmin}/>
      </Modal>}

      {detail&&<Modal title="📋 Requisition Detail" onClose={()=>setDetail(null)}>
        <div style={{marginBottom:"16px"}}>
          <div style={{fontWeight:800,color:C.forest,fontSize:"1.1rem",marginBottom:"8px"}}>
            {detail.item}</div>
          <div style={{background:C.mist,borderRadius:"10px",padding:"12px",
            fontSize:"0.85rem",lineHeight:2}}>
            <div>📅 <strong>Date:</strong> {fmtDate(detail.createdAt)}</div>
            <div>🏢 <strong>Department:</strong> {detail.dept}</div>
            <div>👤 <strong>Requested By:</strong> {detail.requestedBy}</div>
            <div>📦 <strong>Quantity:</strong> {detail.qty} {detail.unit||"pcs"}</div>
            <div>🔀 <strong>Approval Authority:</strong> {detail.approverRole==="admin"
              ?"Stores Admin":"COO (Administration)"}</div>
            {detail.urgency&&detail.urgency!=="normal"&&(
              <div>🚨 <strong>Urgency:</strong>
                <span style={{marginLeft:"6px",background:detail.urgency==="critical"?C.danger:C.warn,
                  color:"white",padding:"2px 8px",borderRadius:"10px",fontSize:"0.75rem",
                  fontWeight:700}}>{detail.urgency.toUpperCase()}</span>
              </div>
            )}
            {detail.reason&&<div>💬 <strong>Reason:</strong> {detail.reason}</div>}
            <div>📌 <strong>Status:</strong>
              <span style={{marginLeft:"6px",
                color:detail.status==="approved"?C.ok:detail.status==="rejected"?C.danger:C.warn,
                fontWeight:800}}>{detail.status.toUpperCase()}</span>
            </div>
            {detail.approvedBy&&<div>✅ <strong>Actioned By:</strong> {detail.approvedBy}</div>}
            {detail.adminNote&&<div style={{color:detail.status==="approved"?C.ok:C.danger}}>
              📝 <strong>Note:</strong> {detail.adminNote}</div>}
          </div>
        </div>
        {/* Approval History Timeline */}
        <ReqHistory reqId={detail.id}/>
        {canDecide(detail)&&(
          <ReqDecide req={detail} onApprove={approveReq} onReject={rejectReq}/>
        )}
        {!canDecide(detail)&&detail.status==="pending"&&(
          <div style={{padding:"10px",background:"#fff8e7",borderRadius:"8px",
            fontSize:"0.82rem",color:C.timber,textAlign:"center",fontWeight:600}}>
            ⏳ Waiting for {detail.approverRole==="admin"?"Stores Admin":"COO"} to approve
          </div>
        )}
      </Modal>}
    </div>
  );
}
function ReqDecide({req,onApprove,onReject}){
  const [note,setNote]=useState("");
  return(<div>
    <Inp label="Note (optional)" value={note}
      onChange={e=>setNote(e.target.value)} placeholder="e.g. Approved for Monday"/>
    <div style={{display:"flex",gap:"8px"}}>
      <Btn onClick={()=>onApprove(req.id,req)} color={C.ok}
        style={{flex:1,justifyContent:"center"}}>✓ Approve</Btn>
      <Btn onClick={()=>onReject(req.id,req,note)} color={C.danger}
        style={{flex:1,justifyContent:"center"}}>✗ Reject</Btn>
    </div>
  </div>);
}
function ReqForm({onSubmit,loading,user,isAdmin}){
  const [f,setF]=useState({item:"",qty:"",unit:"pcs",urgency:"normal",reason:""});
  const dest=isAdmin?"Administration (COO)":"Stores Manager";
  return(<div>
    <div style={{padding:"8px",background:"#f0f4ff",borderRadius:"8px",
      fontSize:"0.78rem",color:C.blue,marginBottom:"10px",fontWeight:700}}>
      📤 This request will go to: <strong>{dest}</strong></div>
    <Inp label="Item / Description *" value={f.item}
      onChange={e=>setF({...f,item:e.target.value})} placeholder="What do you need?"/>
    <div style={{display:"flex",gap:"8px"}}>
      <Inp label="Qty *" type="number" value={f.qty}
        onChange={e=>setF({...f,qty:e.target.value})} wrapStyle={{flex:1}}/>
      <Sel label="Unit" value={f.unit}
        onChange={e=>setF({...f,unit:e.target.value})} wrapStyle={{flex:1}}>
        <option>pcs</option><option>Litres</option><option>Kg</option>
        <option>Boxes</option><option>Bags</option>
      </Sel>
    </div>
    <Sel label="Urgency" value={f.urgency} onChange={e=>setF({...f,urgency:e.target.value})}>
      <option value="normal">Normal</option>
      <option value="urgent">Urgent</option>
      <option value="critical">Critical</option>
    </Sel>
    <Inp label="Reason" value={f.reason}
      onChange={e=>setF({...f,reason:e.target.value})} placeholder="Why is this needed?"/>
    <Btn onClick={()=>onSubmit(f)} loading={loading}
      style={{width:"100%",justifyContent:"center"}}>Submit to {dest}</Btn>
  </div>);
}

// ─── REQUISITION HISTORY TIMELINE ────────────────────────────────────────────
function ReqHistory({reqId}){
  const [hist,setHist]=useState([]);
  useEffect(()=>{
    if(!reqId) return;
    const q=query(collection(db,"requisitionHistory"),
      where("reqId","==",reqId));
    return onSnapshot(q,s=>{
      const all=s.docs.map(d=>({id:d.id,...d.data()}));
      all.sort((a,b)=>(a.time?.seconds||0)-(b.time?.seconds||0)); // oldest first
      setHist(all);
    },()=>{});
  },[reqId]);
  if(!hist.length) return null;
  return(
    <div style={{marginBottom:"14px"}}>
      <div style={{fontWeight:700,color:C.forest,fontSize:"0.78rem",
        textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:"8px"}}>
        📜 Approval Timeline</div>
      {hist.map(h=>(
        <div key={h.id} style={{display:"flex",gap:"10px",marginBottom:"8px"}}>
          <div style={{width:"3px",background:h.action==="approved"?C.ok:C.danger,
            borderRadius:"2px",flexShrink:0}}/>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:"0.82rem",
              color:h.action==="approved"?C.ok:C.danger}}>
              {h.action==="approved"?"✅ APPROVED":"❌ REJECTED"}</div>
            <div style={{fontSize:"0.75rem",color:C.timber}}>{h.by} · {h.role}</div>
            {h.note&&<div style={{fontSize:"0.72rem",color:"#999",marginTop:"2px"}}>
              Note: {h.note}</div>}
            <div style={{fontSize:"0.68rem",color:"#bbb"}}>
              {h.time?.toDate?h.time.toDate().toLocaleString("en-GB"):"—"}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── RECEIPTS ─────────────────────────────────────────────────────────────────
function ReceiptsModule({user}){
  const [receipts,setReceipts]=useState([]);
  const [modal,setModal]=useState(false);
  const [view,setView]=useState(null);
  const [toastEl,showToast]=useToast();
  const [loading,setLoading]=useState(false);

  useEffect(()=>{
    const isAdminOrHR=user.role==="admin"||user.role==="hr";
    const q=isAdminOrHR
      ?query(collection(db,"receipts"))
      :query(collection(db,"receipts"),where("dept","==",user.dept));
    return onSnapshot(q,s=>{
      const all=s.docs.map(d=>({id:d.id,...d.data()}));
      all.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setReceipts(all);
    },e=>console.log("Receipts:",e.message));
  },[user]);

  const save=async(f)=>{
    if(!f.vendor&&!f.amount) return showToast("Add vendor or amount","warn");
    setLoading(true);
    try {
      let imageUrl=null;
      if(f.imageBlob){
        try {
          showToast("📤 Uploading image…","info");
          const imgRef=sRef(storage,`receipts/${Date.now()}_${user.id}.jpg`);
          await uploadBytes(imgRef,f.imageBlob,{contentType:"image/jpeg"});
          imageUrl=await getDownloadURL(imgRef);
        } catch(uploadErr){
          // Don't block save if image upload fails — save receipt without image
          showToast("⚠ Image upload failed — saving without photo","warn");
          imageUrl=null;
        }
      }
      await addDoc(collection(db,"receipts"),{
        vendor:f.vendor||"",amount:f.amount||"",description:f.description||"",
        imageUrl:imageUrl||null,recordedBy:user?.name||user?.username||"Unknown",
        dept:user.dept,createdAt:serverTimestamp()
      });
      showToast("✅ Receipt saved!"); setModal(false);
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };

  return(
    <div style={{padding:"0 12px 80px"}}>
      {toastEl}
      <div style={{display:"flex",justifyContent:"space-between",
        alignItems:"center",marginBottom:"12px",paddingTop:"4px"}}>
        <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest}}>🧾 Receipts</div>
        <Btn sm onClick={()=>setModal(true)}>+ Add</Btn>
      </div>
      {receipts.map(r=>(
        <Card key={r.id} style={{marginBottom:"8px",cursor:"pointer"}} onClick={()=>setView(r)}>
          <div style={{display:"flex",alignItems:"center",gap:"12px"}}>
            {r.imageUrl
              ?<img src={r.imageUrl} alt="receipt" style={{width:"52px",height:"52px",
                  borderRadius:"8px",objectFit:"cover",flexShrink:0}}/>
              :<div style={{width:"52px",height:"52px",borderRadius:"8px",
                  background:C.mist,display:"flex",alignItems:"center",
                  justifyContent:"center",fontSize:"1.5rem",flexShrink:0}}>🧾</div>}
            <div style={{flex:1}}>
              <div style={{fontWeight:800,color:C.forest}}>{r.vendor||"Receipt"}</div>
              {r.amount&&<div style={{fontSize:"0.88rem",color:C.gold,fontWeight:800}}>
                GH₵ {r.amount}</div>}
              <div style={{fontSize:"0.72rem",color:"#888"}}>
                {r.dept} · {fmtDate(r.createdAt)}</div>
            </div>
          </div>
        </Card>
      ))}
      {receipts.length===0&&<div style={{textAlign:"center",color:"#aaa",padding:"30px"}}>
        No receipts yet.</div>}
      {modal&&<Modal title="Add Receipt" onClose={()=>setModal(false)}>
        <ReceiptForm onSave={save} loading={loading}/>
      </Modal>}
      {view&&<Modal title="Receipt Detail" onClose={()=>setView(null)}>
        {view.imageUrl&&<img src={view.imageUrl} alt="receipt"
          style={{width:"100%",borderRadius:"10px",marginBottom:"12px",maxHeight:"250px",objectFit:"contain"}}/>}
        <div style={{lineHeight:2,fontSize:"0.88rem"}}>
          {view.vendor&&<div><strong>Vendor:</strong> {view.vendor}</div>}
          {view.amount&&<div><strong>Amount:</strong> GH₵ {view.amount}</div>}
          {view.description&&<div><strong>Description:</strong> {view.description}</div>}
          <div><strong>Dept:</strong> {view.dept}</div>
          <div><strong>Date:</strong> {fmtDate(view.createdAt)}</div>
        </div>
      </Modal>}
    </div>
  );
}
function ReceiptForm({onSave,loading}){
  const [f,setF]=useState({vendor:"",amount:"",description:"",imageBlob:null,imagePreview:""});
  const [imgL,setImgL]=useState(false);
  const handleImg=e=>{
    const file=e.target.files[0]; if(!file) return;
    setImgL(true);
    // Store raw File object (Blob) for uploadBytes — much faster than base64
    const preview=URL.createObjectURL(file);
    setF(p=>({...p,imageBlob:file,imagePreview:preview}));
    setImgL(false);
  };
  return(<div>
    <div style={{marginBottom:"12px"}}>
      <label style={{display:"flex",flexDirection:"column",alignItems:"center",
        justifyContent:"center",background:C.mist,border:`2px dashed ${C.border}`,
        borderRadius:"10px",padding:"16px",cursor:"pointer",minHeight:"80px"}}>
        {imgL?<div>Loading…</div>
          :f.imagePreview
            ?<img src={f.imagePreview} alt="preview"
                style={{maxHeight:"140px",borderRadius:"8px",maxWidth:"100%"}}/>
            :<><div style={{fontSize:"2rem"}}>📷</div>
              <div style={{fontSize:"0.8rem",color:C.timber,fontWeight:700}}>
                Tap to snap or upload (optional)</div></>}
        <input type="file" accept="image/*" capture="environment"
          onChange={handleImg} style={{display:"none"}}/>
      </label>
    </div>
    <Inp label="Vendor *" value={f.vendor}
      onChange={e=>setF({...f,vendor:e.target.value})} placeholder="Supplier name"/>
    <Inp label="Amount (GH₵)" type="number" value={f.amount}
      onChange={e=>setF({...f,amount:e.target.value})} placeholder="0.00"/>
    <Inp label="Description" value={f.description}
      onChange={e=>setF({...f,description:e.target.value})}/>
    <div style={{fontSize:"0.72rem",color:"#aaa",marginBottom:"8px",textAlign:"center"}}>
      Receipt saves instantly — photo uploads separately</div>
    <Btn onClick={()=>onSave(f)} loading={loading}
      style={{width:"100%",justifyContent:"center"}}>Save Receipt</Btn>
  </div>);
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
function ChatModule({user}){
  const [activeDept,setActiveDept]=useState(null);
  const isAdmin=user.role==="admin";
  const isHR=user.role==="hr"; // v8.4 strict

  // STRICT CHAT RULES:
  // Admin → sees all departments, can message any
  // HR → talks directly to admin only (not other departments)
  // Dept heads → talks directly to admin only

  if(isAdmin){
    // Admin sees department list, picks who to chat
    if(!activeDept) return <AdminChatList user={user} onSelect={setActiveDept}/>;
    return <ChatThread dept={activeDept} user={user} onBack={()=>setActiveDept(null)}/>;
  }

  // HR and dept heads go directly to "admin" thread — no department selection
  // Thread is named after their own department so admin can identify them
  return <ChatThread dept={user.dept} user={user} onBack={null}/>;
}
function AdminChatList({user,onSelect}){
  const [threads,setThreads]=useState({});

  useEffect(()=>{
    // Listen to last message in each dept using Firestore
    const unsubs=DEPTS.map(d=>{
      const q=query(
        collection(db,"chats",d,"messages"),
        orderBy("createdAt","desc")
      );
      return onSnapshot(q,s=>{
        const msgs=s.docs.map(doc=>({id:doc.id,...doc.data()}));
        setThreads(prev=>({...prev,[d]:msgs}));
      },()=>{});
    });
    return()=>unsubs.forEach(u=>u());
  },[]);

  return(
    <div style={{padding:"0 12px 80px"}}>
      <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest,
        marginBottom:"14px",paddingTop:"4px"}}>💬 Department Chats</div>
      {DEPTS.map(d=>{
        const msgs=(threads[d]||[]).slice().reverse();
        const unread=msgs.filter(m=>m.from!=="admin"&&!m.read).length;
        const last=msgs[msgs.length-1];
        return(
          <Card key={d} style={{marginBottom:"8px",cursor:"pointer",
            borderLeft:`4px solid ${unread>0?C.gold:C.border}`}}
            onClick={()=>onSelect(d)}>
            <div style={{display:"flex",alignItems:"center",gap:"12px"}}>
              <div style={{width:"44px",height:"44px",borderRadius:"50%",
                background:unread>0?C.gold:C.mist,display:"flex",alignItems:"center",
                justifyContent:"center",fontWeight:800,
                color:unread>0?C.white:C.timber,
                fontSize:"0.85rem",flexShrink:0}}>{d.slice(0,2).toUpperCase()}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",justifyContent:"space-between"}}>
                  <div style={{fontWeight:800,color:C.forest}}>{d}</div>
                  {last&&<div style={{fontSize:"0.68rem",color:"#aaa"}}>
                    {fmtTime(last.createdAt)}</div>}
                </div>
                <div style={{fontSize:"0.75rem",color:"#888",whiteSpace:"nowrap",
                  overflow:"hidden",textOverflow:"ellipsis"}}>
                  {last?last.text:"No messages yet"}</div>
              </div>
              {unread>0&&<div style={{background:C.gold,color:C.white,
                borderRadius:"50%",width:"22px",height:"22px",display:"flex",
                alignItems:"center",justifyContent:"center",
                fontSize:"0.72rem",fontWeight:800,flexShrink:0}}>
                {unread}</div>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function ChatThread({dept,user,onBack}){
  const [msgs,setMsgs]=useState([]);
  const [input,setInput]=useState("");
  const bottomRef=useRef(null);
  const isAdmin=user.role==="admin"; // ONLY admin sends as "admin"

  useEffect(()=>{
    // Firestore subcollection: chats/{dept}/messages
    const q=query(
      collection(db,"chats",dept,"messages"),
      orderBy("createdAt","asc")
    );
    const unsub=onSnapshot(q,s=>{
      const all=s.docs.map(d=>({id:d.id,...d.data()}));
      setMsgs(all);
      // Mark unread messages as read
      s.docs.forEach(d=>{
        const m=d.data();
        if(isAdmin&&m.from!=="admin"&&!m.read)
          updateDoc(doc(db,"chats",dept,"messages",d.id),{read:true}).catch(()=>{});
        if(!isAdmin&&m.from==="admin"&&!m.read)
          updateDoc(doc(db,"chats",dept,"messages",d.id),{read:true}).catch(()=>{});
      });
    },e=>console.log("chat error:",e.message));
    return()=>unsub();
  },[dept,isAdmin]);

  useEffect(()=>{
    bottomRef.current?.scrollIntoView({behavior:"smooth"});
  },[msgs]);

  const send=async()=>{
    if(!input.trim()) return;
    const text=input.trim();
    setInput("");
    try {
      await addDoc(collection(db,"chats",dept,"messages"),{
        text,
        from:isAdmin?"admin":user.dept,
        senderName:user?.name||user?.username||"Unknown",
        dept,
        read:false,
        createdAt:Date.now()
      });
    } catch(e){
      setInput(text); // restore on error
      console.error("Send failed:",e.message);
    }
  };

  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 116px)"}}>
      <div style={{padding:"10px 12px",
        background:`linear-gradient(90deg,${C.forest},${C.bark})`,
        display:"flex",alignItems:"center",gap:"10px",flexShrink:0}}>
        {onBack&&<button onClick={onBack} style={{background:"none",border:"none",
          color:C.cream,fontFamily:"inherit",fontWeight:700,cursor:"pointer",
          fontSize:"1.1rem"}}>←</button>}
        <div style={{width:"36px",height:"36px",borderRadius:"50%",
          background:C.gold,display:"flex",alignItems:"center",
          justifyContent:"center",fontWeight:800,color:C.white,
          fontSize:"0.85rem",flexShrink:0}}>{dept.slice(0,2).toUpperCase()}</div>
        <div>
          <div style={{fontWeight:800,color:C.cream,fontSize:"0.9rem"}}>{dept}</div>
          <div style={{fontSize:"0.65rem",color:"rgba(245,237,214,0.6)"}}>
            Real-time Chat</div>
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"12px",
        paddingBottom:"80px",
        background:"#f5f0e8",minHeight:0}}>
        {msgs.length===0&&(
          <div style={{textAlign:"center",padding:"30px"}}>
            <div style={{fontSize:"2rem",marginBottom:"8px"}}>💬</div>
            <div style={{color:"#aaa",fontSize:"0.85rem",marginBottom:"16px"}}>
              {isAdmin
                ?`Start a conversation with ${dept} department`
                :"No messages yet. Send a message to admin."}</div>
            {isAdmin&&(
              <div style={{display:"flex",flexDirection:"column",
                gap:"8px",maxWidth:"240px",margin:"0 auto"}}>
                {["How is work going today?",
                  "Please send your stock report",
                  "Your requisition has been approved",
                  "Urgent: please report to stores"].map(s=>(
                  <button key={s} onClick={()=>setInput(s)}
                    style={{background:"#f0ebe0",border:`1px solid ${C.border}`,
                      borderRadius:"20px",padding:"8px 12px",fontSize:"0.78rem",
                      cursor:"pointer",color:C.forest,fontWeight:600,
                      fontFamily:"inherit",textAlign:"left"}}>{s}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {msgs.map((m,i)=>{
          const mine=(isAdmin&&m.from==="admin")||(!isAdmin&&m.from===user.dept);
          return(
            <div key={m.id||i} style={{display:"flex",
              justifyContent:mine?"flex-end":"flex-start",marginBottom:"8px"}}>
              <div style={{maxWidth:"80%"}}>
                {!mine&&<div style={{fontSize:"0.68rem",color:"#aaa",
                  marginBottom:"2px",paddingLeft:"4px"}}>
                  {m.from==="admin"?"Abraham Sackey (Admin)":m.senderName||m.from}
                </div>}
                <div style={{background:mine?C.forest:C.white,
                  color:mine?C.cream:C.ink,
                  borderRadius:mine?"16px 16px 4px 16px":"16px 16px 16px 4px",
                  padding:"10px 14px",fontSize:"0.86rem",lineHeight:"1.5",
                  boxShadow:"0 1px 4px rgba(0,0,0,0.1)",
                  border:mine?"none":`1px solid ${C.border}`,
                  whiteSpace:"pre-wrap"}}>{m.text}</div>
                <div style={{fontSize:"0.65rem",color:"#bbb",marginTop:"2px",
                  textAlign:mine?"right":"left",
                  padding:mine?"0 4px 0 0":"0 0 0 4px"}}>
                  {fmtTime(m.createdAt)}{mine&&(m.read?" ✓✓":" ✓")}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef}/>
      </div>

      <div style={{position:"fixed",bottom:"56px",left:"50%",
        transform:"translateX(-50%)",width:"100%",maxWidth:"480px",
        padding:"10px 12px",background:C.white,
        borderTop:`1px solid ${C.border}`,display:"flex",
        gap:"8px",zIndex:500,
        paddingBottom:"calc(10px + env(safe-area-inset-bottom,0px))"}}>
        <input value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&send()}
          placeholder="Type a message…"
          style={{flex:1,padding:"10px 16px",border:`1.5px solid ${C.border}`,
            borderRadius:"30px",fontSize:"0.88rem",fontFamily:"inherit",
            outline:"none",background:C.white}}/>
        <button onClick={send} disabled={!input.trim()}
          style={{background:!input.trim()?C.border:C.forest,border:"none",
            borderRadius:"50%",width:"44px",height:"44px",
            cursor:!input.trim()?"not-allowed":"pointer",
            display:"flex",alignItems:"center",justifyContent:"center",
            color:C.white,flexShrink:0,fontSize:"1rem"}}>➤</button>
      </div>
    </div>
  );
}

// ─── ATTENDANCE ───────────────────────────────────────────────────────────────
function AttendanceModule({user}){
  const [tab,setTab]=useState("mark");
  const [workers,setWorkers]=useState([]);
  const [att,setAtt]=useState({});
  const [toastEl,showToast]=useToast();
  const [loading,setLoading]=useState(false);
  const [selDate,setSelDate]=useState(today());
  const dept=user.dept;

  useEffect(()=>{
    return onSnapshot(query(collection(db,"workers"),where("dept","==",dept)),
      s=>setWorkers(s.docs.map(d=>({id:d.id,...d.data()}))));
  },[dept]);

  useEffect(()=>{
    if(!selDate||workers.length===0) return;
    // v8.2: flat attendance collection — query by dept + date
    getDocs(query(collection(db,"attendance"),
      where("dept","==",dept),where("date","==",selDate)))
      .then(s=>{
        const a={};
        s.docs.forEach(d=>{ a[d.data().workerId]=d.data().present; });
        setAtt(a);
      }).catch(()=>{});
  },[dept,selDate,workers]);

  const saveAtt=async()=>{
    setLoading(true);
    try {
      // v8.2: flat attendance/{dept_date_workerId} — one collection, no subcollections
      for(const w of workers){
        const docId=`${dept}_${selDate}_${w.id}`;
        await setDoc(doc(db,"attendance",docId),{
          workerId:w.id,workerName:w.name,workerType:w.type||"casual",
          dept,date:selDate,present:!!att[w.id],
          markedBy:user?.name||user?.username||"Unknown",
          status:"pending", // HR must approve
          createdAt:serverTimestamp()
        });
      }
      showToast("✅ Attendance saved — awaiting HR approval!");
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };

  const submitWeekly=async()=>{
    setLoading(true);
    try {
      const wStart=weekStart();
      // v8.2: flat attendance collection — query by dept
      const snap=await getDocs(query(collection(db,"attendance"),
        where("dept","==",dept),where("present","==",true)));
      const workerDays={};
      snap.docs.map(d=>d.data()).forEach(r=>{
        if(r.date>=wStart&&r.date<=today()){
          workerDays[r.workerId]={
            name:r.workerName,
            days:(workerDays[r.workerId]?.days||0)+1
          };
        }
      });
      const chopList=Object.entries(workerDays)
        .map(([id,{name,days}])=>({workerId:id,name,days,amount:days*CHOP_RATE}));
      const total=chopList.reduce((s,w)=>s+w.amount,0);
      await addDoc(collection(db,"chopMoney"),{
        dept,weekStart:wStart,weekEnd:today(),chopList,totalAmount:total,
        submittedBy:user?.name||user?.username||"Unknown",
        status:"pending",createdAt:serverTimestamp()
      });
      showToast(`✅ Chop money sent to HR!\nTotal: GH₵${total}`);
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };

  const submitMonthly=async()=>{
    setLoading(true);
    try {
      const mStart=monthStart();
      const summary={};
      workers.forEach(w=>{
        summary[w.id]={name:w.name,type:w.type||"casual",present:0,absent:0};
      });
      // v8.2: flat attendance collection — single query by dept
      const snap=await getDocs(query(collection(db,"attendance"),
        where("dept","==",dept)));
      snap.docs.map(d=>d.data()).forEach(r=>{
        if(r.date>=mStart&&r.date<=today()){
          if(!summary[r.workerId])
            summary[r.workerId]={name:r.workerName,type:"casual",present:0,absent:0};
          if(r.present) summary[r.workerId].present++;
          else summary[r.workerId].absent++;
        }
      });
      await addDoc(collection(db,"attendanceReports"),{
        dept,month:mStart.slice(0,7),monthStart:mStart,monthEnd:today(),
        summary:Object.entries(summary).map(([id,v])=>({
          workerId:id,...v,chopMoney:v.present*CHOP_RATE
        })),
        submittedBy:user?.name||user?.username||"Unknown",
        status:"pending",createdAt:serverTimestamp()
      });
      showToast("✅ Monthly attendance sent to HR!");
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };

  return(
    <div style={{padding:"0 12px 80px"}}>
      {toastEl}
      <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest,
        marginBottom:"12px",paddingTop:"4px"}}>📅 Attendance — {dept}</div>
      <TabBar tabs={[{id:"mark",label:"Mark Daily"},
        {id:"weekly",label:"Chop Money"},{id:"monthly",label:"Monthly"}]}
        active={tab} onSelect={setTab}/>

      {tab==="mark"&&(
        <div>
          <Inp type="date" label="Date" value={selDate}
            onChange={e=>setSelDate(e.target.value)}/>
          {workers.length===0&&(
            <div style={{textAlign:"center",color:"#aaa",padding:"30px",fontSize:"0.85rem"}}>
              No workers registered for {dept}.<br/>HR must add workers first.</div>
          )}
          {workers.map(w=>(
            <Card key={w.id} style={{marginBottom:"8px",
              borderLeft:`4px solid ${att[w.id]?C.ok:C.border}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontWeight:700,color:C.forest}}>{w.name}</div>
                  <div style={{fontSize:"0.75rem",color:"#888"}}>
                    {w.type==="permanent"?"Permanent":"Casual"}</div>
                </div>
                <button onClick={()=>setAtt(a=>({...a,[w.id]:!a[w.id]}))}
                  style={{width:"44px",height:"26px",borderRadius:"13px",
                    border:"none",cursor:"pointer",
                    background:att[w.id]?C.ok:C.border,position:"relative",
                    transition:"background 0.2s"}}>
                  <div style={{position:"absolute",top:"3px",width:"20px",height:"20px",
                    borderRadius:"50%",background:C.white,transition:"left 0.2s",
                    left:att[w.id]?"21px":"3px",boxShadow:"0 1px 4px rgba(0,0,0,0.2)"}}/>
                </button>
              </div>
              <div style={{fontSize:"0.72rem",color:att[w.id]?C.ok:C.danger,
                fontWeight:700,marginTop:"4px"}}>
                {att[w.id]?"✓ Present":"✗ Absent"}</div>
            </Card>
          ))}
          {workers.length>0&&(
            <Btn onClick={saveAtt} loading={loading}
              style={{width:"100%",justifyContent:"center",marginTop:"8px"}}>
              Save Attendance for {selDate}</Btn>
          )}
        </div>
      )}

      {tab==="weekly"&&(
        <Card style={{background:C.mist,border:`1.5px solid ${C.sage}`}}>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"6px"}}>
            💰 Weekly Chop Money (GH₵{CHOP_RATE}/day)</div>
          <div style={{fontSize:"0.82rem",color:"#888",marginBottom:"12px",lineHeight:1.6}}>
            Calculates from this week's attendance and sends to HR for approval.</div>
          <Btn onClick={submitWeekly} loading={loading}
            style={{width:"100%",justifyContent:"center",background:C.gold,borderColor:C.gold}}>
            📤 Submit Weekly Chop Money to HR</Btn>
        </Card>
      )}

      {tab==="monthly"&&(
        <Card style={{background:C.mist,border:`1.5px solid ${C.sage}`}}>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"6px"}}>
            📊 Monthly Attendance Report</div>
          <div style={{fontSize:"0.82rem",color:"#888",marginBottom:"12px"}}>
            Summary for {new Date().toLocaleString("en-GB",{month:"long",year:"numeric"})}.</div>
          <Btn onClick={submitMonthly} loading={loading}
            style={{width:"100%",justifyContent:"center"}}>
            📤 Submit Monthly Report to HR</Btn>
        </Card>
      )}
    </div>
  );
}

// ─── HR MODULE ────────────────────────────────────────────────────────────────
function HRModule({user}){
  const [tab,setTab]=useState("roster");
  const isHR=user.role==="hr"; // v8.4 strict
  return(
    <div style={{padding:"0 12px 80px"}}>
      <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest,
        marginBottom:"12px",paddingTop:"4px"}}>👥 HR Management</div>
      <TabBar tabs={[{id:"roster",label:"Roster"},{id:"chop",label:"Chop $"},
        {id:"attendance",label:"Attend."},{id:"attapprove",label:"Approve Att."}]}
        active={tab} onSelect={setTab}/>
      {tab==="roster"&&<StaffRoster user={user}/>}
      {tab==="chop"&&<ChopMoney user={user}/>}
      {tab==="attendance"&&<AttendanceReports user={user}/>}
      {tab==="attapprove"&&<AttendanceApproval user={user}/>}
    </div>
  );
}

// ─── ATTENDANCE APPROVAL (HR ONLY) ───────────────────────────────────────────
function AttendanceApproval({user}){
  const [records,setRecords]=useState([]);
  const [toastEl,showToast]=useToast();
  const isHR=user.role==="hr"; // v8.4: strict role check

  useEffect(()=>{
    return onSnapshot(query(collection(db,"attendance"),
      where("status","==","pending")),
      s=>{
        const all=s.docs.map(d=>({id:d.id,...d.data()}));
        all.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
        setRecords(all);
      },()=>{});
  },[]);

  const approveRecord=async(id)=>{
    if(!isHR){ showToast("Only HR can approve attendance","danger"); return; }
    try {
      await updateDoc(doc(db,"attendance",id),{
        status:"approved",
        approvedBy:user?.name||user?.username||"HR",
        approvedAt:serverTimestamp()
      });
      showToast("✅ Attendance approved!");
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
  };

  const approveBatch=async(deptDate)=>{
    if(!isHR){ showToast("Only HR can approve attendance","danger"); return; }
    const batch=records.filter(r=>r.dept===deptDate.dept&&r.date===deptDate.date&&r.status==="pending");
    try {
      for(const r of batch){
        await updateDoc(doc(db,"attendance",r.id),{
          status:"approved",approvedBy:user?.name||"HR",approvedAt:serverTimestamp()
        });
      }
      showToast(`✅ Approved all ${deptDate.dept} attendance for ${deptDate.date}`);
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
  };

  // Group by dept + date
  const groups={};
  records.forEach(r=>{
    const key=`${r.dept}__${r.date}`;
    if(!groups[key]) groups[key]={dept:r.dept,date:r.date,records:[]};
    groups[key].records.push(r);
  });

  return(
    <div>
      {toastEl}
      {!isHR&&(
        <div style={{padding:"12px",background:"#fff8e7",borderRadius:"8px",
          color:C.timber,fontWeight:700,fontSize:"0.85rem"}}>
          ⚠ Only HR can approve attendance records.</div>
      )}
      {Object.keys(groups).length===0&&(
        <div style={{textAlign:"center",color:"#aaa",padding:"30px"}}>
          No pending attendance records.</div>
      )}
      {Object.entries(groups).map(([key,g])=>(
        <Card key={key} style={{marginBottom:"10px",
          borderLeft:`4px solid ${C.gold}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"8px"}}>
            <div>
              <div style={{fontWeight:800,color:C.forest}}>{g.dept}</div>
              <div style={{fontSize:"0.75rem",color:"#888"}}>{g.date} · {g.records.length} workers</div>
            </div>
            {isHR&&(
              <Btn sm onClick={()=>approveBatch(g)} color={C.ok}>✓ Approve All</Btn>
            )}
          </div>
          {g.records.map(r=>(
            <div key={r.id} style={{display:"flex",justifyContent:"space-between",
              alignItems:"center",padding:"6px 0",borderTop:`1px dashed ${C.border}`}}>
              <div>
                <span style={{fontWeight:600,color:C.forest,fontSize:"0.85rem"}}>{r.workerName}</span>
                <span style={{marginLeft:"8px",
                  color:r.present?C.ok:C.danger,fontSize:"0.75rem",fontWeight:700}}>
                  {r.present?"Present":"Absent"}</span>
              </div>
              {isHR&&r.status==="pending"&&(
                <Btn sm onClick={()=>approveRecord(r.id)} color={C.ok}>✓</Btn>
              )}
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}
function StaffRoster({user}){
  const [workers,setWorkers]=useState([]);
  const [modal,setModal]=useState(false);
  const [toastEl,showToast]=useToast();
  useEffect(()=>{
    return onSnapshot(collection(db,"workers"),
      s=>setWorkers(s.docs.map(d=>({id:d.id,...d.data()}))));
  },[]);
  const add=async(f)=>{
    if(!f.name||!f.dept) return showToast("Name and dept required","warn");
    // Prevent duplicate worker names
    const existing=await getDocs(query(collection(db,"workers"),
      where("name","==",f.name.trim()),where("dept","==",f.dept)));
    if(!existing.empty) return showToast(`${f.name} already exists in ${f.dept}!`,"danger");
    try {
      await addDoc(collection(db,"workers"),{
        name:f.name.trim(),dept:f.dept,type:f.type||"casual",
        staffId:f.staffId||"",addedBy:user?.name||user?.username||"Unknown",
        createdAt:serverTimestamp()
      });
      showToast("✅ Worker added!"); setModal(false);
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
  };
  const remove=async(id)=>{
    if(!window.confirm("Remove this worker?")) return;
    await deleteDoc(doc(db,"workers",id));
  };
  const grouped=DEPTS.reduce((a,d)=>{a[d]=workers.filter(w=>w.dept===d);return a;},{});
  return(
    <div>
      {toastEl}
      <Btn onClick={()=>setModal(true)}
        style={{width:"100%",justifyContent:"center",marginBottom:"12px"}}>
        + Add Worker</Btn>
      {DEPTS.map(d=>{
        const dw=grouped[d]||[];
        if(!dw.length) return null;
        return(
          <div key={d}>
            <div style={{fontWeight:700,color:C.forest,fontSize:"0.82rem",
              textTransform:"uppercase",letterSpacing:"0.08em",margin:"12px 0 6px"}}>
              {d} ({dw.length})</div>
            {dw.map(w=>(
              <Card key={w.id} style={{display:"flex",alignItems:"center",
                gap:"10px",marginBottom:"6px",padding:"10px 14px"}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:C.forest}}>{w.name}</div>
                  <div style={{fontSize:"0.72rem",color:"#888"}}>
                    {w.type==="permanent"?"Permanent":"Casual"}
                    {w.staffId?` · ID: ${w.staffId}`:""}</div>
                </div>
                <button onClick={()=>remove(w.id)} style={{background:"none",
                  border:"none",color:C.danger,cursor:"pointer",fontSize:"1.1rem"}}>🗑</button>
              </Card>
            ))}
          </div>
        );
      })}
      {workers.length===0&&<div style={{textAlign:"center",color:"#aaa",padding:"30px"}}>
        No workers registered yet.</div>}
      {modal&&<Modal title="Add Worker" onClose={()=>setModal(false)}>
        <AddWorkerForm onSave={add}/>
      </Modal>}
    </div>
  );
}
function AddWorkerForm({onSave}){
  const [f,setF]=useState({name:"",dept:"",type:"casual",staffId:""});
  return(<div>
    <Inp label="Full Name *" value={f.name} onChange={e=>setF({...f,name:e.target.value})}/>
    <Sel label="Department *" value={f.dept} onChange={e=>setF({...f,dept:e.target.value})}>
      <option value="">Select…</option>
      {DEPTS.map(d=><option key={d}>{d}</option>)}
    </Sel>
    <Sel label="Type" value={f.type} onChange={e=>setF({...f,type:e.target.value})}>
      <option value="casual">Casual Worker</option>
      <option value="permanent">Permanent Staff</option>
    </Sel>
    <Inp label="Staff ID (optional)" value={f.staffId}
      onChange={e=>setF({...f,staffId:e.target.value})}/>
    <Btn onClick={()=>onSave(f)} style={{width:"100%",justifyContent:"center"}}>Save Worker</Btn>
  </div>);
}
function ChopMoney({user}){
  const [subs,setSubs]=useState([]);
  const [detail,setDetail]=useState(null);
  const [toastEl,showToast]=useToast();
  // v8.2: HR approves chop money, NOT admin
  const isHR=user.role==="hr"; // v8.4 strict
  useEffect(()=>{
    return onSnapshot(collection(db,"chopMoney"),
      s=>{
        const all=s.docs.map(d=>({id:d.id,...d.data()}));
        all.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
        setSubs(all);
      });  },[]);
  const decide=async(id,action)=>{
    if(!isHR){ showToast("Only HR can approve chop money","danger"); return; }
    await updateDoc(doc(db,"chopMoney",id),{
      status:action==="approved"?"paid":"rejected",
      paidBy:user?.name||user?.username||"HR",
      paidAt:serverTimestamp()
    });
    showToast(action==="approved"?"✅ Approved for payment!":"Rejected");
    setDetail(null);
  };
  return(
    <div>
      {toastEl}
      {subs.length===0&&<div style={{textAlign:"center",color:"#aaa",padding:"30px"}}>
        No chop money submissions yet.</div>}
      {subs.map(s=>(
        <Card key={s.id} style={{borderLeft:`4px solid ${
          s.status==="pending"?C.gold:s.status==="approved"?C.ok:C.danger}`,
          marginBottom:"8px",cursor:"pointer"}} onClick={()=>setDetail(s)}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <div>
              <div style={{fontWeight:800,color:C.forest}}>{s.dept} — {s.weekStart}</div>
              <div style={{fontSize:"0.75rem",color:"#888"}}>{fmtDate(s.createdAt)}</div>
              <div style={{fontWeight:700,color:C.gold}}>GH₵{s.totalAmount}</div>
            </div>
            <Badge color={s.status==="pending"?C.warn:s.status==="approved"?C.ok:C.danger}>
              {s.status.toUpperCase()}</Badge>
          </div>
        </Card>
      ))}
      {detail&&<Modal title="💰 Chop Money Detail" onClose={()=>setDetail(null)}>
        <div style={{background:C.mist,borderRadius:"10px",padding:"12px",marginBottom:"12px"}}>
          <div style={{fontWeight:800,color:C.forest,fontSize:"1rem"}}>{detail.dept}</div>
          <div style={{fontSize:"0.82rem",color:"#888",marginTop:"2px"}}>
            Week: {detail.weekStart} – {detail.weekEnd}</div>
          <div style={{fontWeight:800,color:C.gold,fontSize:"1.3rem",marginTop:"6px"}}>
            Total: GH₵{detail.totalAmount||0}</div>
          <div style={{fontSize:"0.72rem",color:"#aaa"}}>
            GH₵{CHOP_RATE}/day · by {detail.submittedBy}</div>
        </div>
        <div style={{fontWeight:700,color:C.forest,fontSize:"0.82rem",
          textTransform:"uppercase",marginBottom:"8px"}}>Worker Breakdown</div>
        {(detail.chopList||[]).length===0&&(
          <div style={{color:"#aaa",fontSize:"0.82rem",padding:"8px 0"}}>
            No attendance data for this period.</div>
        )}
        {(detail.chopList||[]).map((w,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",
            alignItems:"center",padding:"8px 0",
            borderBottom:`1px dashed ${C.border}`,fontSize:"0.85rem"}}>
            <span style={{fontWeight:600,color:C.forest,flex:2}}>{w.name}</span>
            <span style={{color:"#888",flex:1,textAlign:"center"}}>{w.days}d</span>
            <span style={{fontWeight:800,color:C.gold,flex:1,textAlign:"right"}}>
              GH₵{w.amount}</span>
          </div>
        ))}
        <div style={{display:"flex",gap:"8px",margin:"12px 0"}}>
          <Btn sm onClick={()=>{
            const txt=`KKTR CHOP MONEY REPORT\nDept: ${detail.dept}\nWeek: ${detail.weekStart} – ${detail.weekEnd}\nTotal: GH₵${detail.totalAmount||0}\n\n${(detail.chopList||[]).map(w=>`${w.name}: ${w.days} days = GH₵${w.amount}`).join("\n")}\n\nBy: ${detail.submittedBy}`;
            window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`,"_blank");
          }} color="#25D366" style={{flex:1,justifyContent:"center"}}>📱 WhatsApp</Btn>
          <Btn sm onClick={()=>{
            const txt=`KKTR CHOP MONEY REPORT\nDept: ${detail.dept}\nWeek: ${detail.weekStart} – ${detail.weekEnd}\nTotal: GH₵${detail.totalAmount||0}\n\n${(detail.chopList||[]).map(w=>`${w.name}: ${w.days} days = GH₵${w.amount}`).join("\n")}`;
            window.open(`mailto:?subject=KKTR Chop Money — ${detail.dept}&body=${encodeURIComponent(txt)}`,"_blank");
          }} color={C.timber} style={{flex:1,justifyContent:"center"}}>✉ Email COO</Btn>
        </div>
        {detail.status==="pending"&&isHR&&(
          <div style={{display:"flex",gap:"8px"}}>
            <Btn onClick={()=>decide(detail.id,"approved")} color={C.ok}
              style={{flex:1,justifyContent:"center"}}>✓ Approve</Btn>
            <Btn onClick={()=>decide(detail.id,"rejected")} color={C.danger}
              style={{flex:1,justifyContent:"center"}}>✗ Reject</Btn>
          </div>
        )}
        {detail.status==="pending"&&!isHR&&(
          <div style={{padding:"10px",background:"#fff8e7",borderRadius:"8px",
            fontSize:"0.82rem",color:C.timber,textAlign:"center"}}>
            ⏳ Waiting for HR to approve
          </div>
        )}
        {detail.status==="approved"&&(
          <div style={{padding:"10px",background:"#e8f5e9",borderRadius:"8px",
            fontSize:"0.82rem",color:C.ok,textAlign:"center",fontWeight:700}}>
            ✅ Approved by {detail.approvedBy}
          </div>
        )}
      </Modal>}
    </div>
  );
}
function AttendanceReports({user}){
  const [reports,setReports]=useState([]);
  const [detail,setDetail]=useState(null);
  const [toastEl,showToast]=useToast();

  useEffect(()=>{
    return onSnapshot(collection(db,"attendanceReports"),
      s=>{
        const all=s.docs.map(d=>({id:d.id,...d.data()}));
        all.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
        setReports(all);
      });
  },[]);

  // Group by department so HR sees each dept's reports together
  const byDept=DEPTS.reduce((a,d)=>{
    a[d]=reports.filter(r=>r.dept===d);
    return a;
  },{});

  return(
    <div>
      {toastEl}
      {reports.length===0&&(
        <div style={{textAlign:"center",color:"#aaa",padding:"30px"}}>
          No attendance reports submitted yet.</div>
      )}

      {DEPTS.map(dept=>{
        const deptReports=byDept[dept]||[];
        if(!deptReports.length) return null;
        const pendingCount=deptReports.filter(r=>r.status==="pending").length;
        return(
          <div key={dept}>
            {/* Department header */}
            <div style={{fontWeight:700,color:C.forest,fontSize:"0.82rem",
              textTransform:"uppercase",letterSpacing:"0.08em",
              margin:"14px 0 6px",display:"flex",
              justifyContent:"space-between",alignItems:"center"}}>
              <span>🏢 {dept} ({deptReports.length})</span>
              {pendingCount>0&&(
                <span style={{background:C.warn,color:C.white,
                  borderRadius:"10px",padding:"2px 8px",
                  fontSize:"0.68rem",fontWeight:800}}>
                  {pendingCount} pending</span>
              )}
            </div>
            {deptReports.map(r=>(
              <Card key={r.id}
                style={{borderLeft:`4px solid ${r.status==="pending"?C.warn:C.ok}`,
                  marginBottom:"8px",cursor:"pointer"}}
                onClick={()=>setDetail(r)}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontWeight:800,color:C.forest}}>{r.month}</div>
                    <div style={{fontSize:"0.72rem",color:"#888"}}>
                      Submitted by {r.submittedBy}</div>
                    {r.summary&&(
                      <div style={{fontSize:"0.72rem",color:C.timber,marginTop:"2px"}}>
                        {r.summary.length} worker{r.summary.length!==1?"s":""} ·
                        Total GH₵{(r.summary.reduce((s,w)=>s+(w.chopMoney||0),0)).toFixed(0)}
                      </div>
                    )}
                  </div>
                  <Badge color={r.status==="pending"?C.warn:C.ok}>
                    {(r.status||"pending").toUpperCase()}</Badge>
                </div>
              </Card>
            ))}
          </div>
        );
      })}

      {detail&&(
        <Modal title="📊 Attendance Report" onClose={()=>setDetail(null)}>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"4px",fontSize:"1rem"}}>
            {detail.dept} — {detail.month}</div>
          <div style={{fontSize:"0.75rem",color:"#888",marginBottom:"12px"}}>
            Submitted by {detail.submittedBy}</div>

          {/* Summary table header */}
          <div style={{display:"flex",justifyContent:"space-between",
            padding:"4px 0 8px",borderBottom:`2px solid ${C.border}`,
            fontSize:"0.72rem",fontWeight:700,color:C.timber,
            textTransform:"uppercase",letterSpacing:"0.05em"}}>
            <span style={{flex:2}}>Worker</span>
            <span style={{flex:1,textAlign:"center",color:C.ok}}>Present</span>
            <span style={{flex:1,textAlign:"center",color:C.danger}}>Absent</span>
            <span style={{flex:1,textAlign:"right",color:C.gold}}>Chop</span>
          </div>

          {(detail.summary||[]).map((w,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",
              alignItems:"center",padding:"7px 0",
              borderBottom:`1px dashed ${C.border}`,fontSize:"0.82rem"}}>
              <span style={{flex:2,fontWeight:600,color:C.forest}}>{w.name}</span>
              <span style={{flex:1,textAlign:"center",color:C.ok,fontWeight:700}}>
                {w.present}✓</span>
              <span style={{flex:1,textAlign:"center",color:C.danger,fontWeight:700}}>
                {w.absent}✗</span>
              <span style={{flex:1,textAlign:"right",color:C.gold,fontWeight:800}}>
                GH₵{w.chopMoney||0}</span>
            </div>
          ))}

          {/* Totals row */}
          {detail.summary&&detail.summary.length>0&&(
            <div style={{display:"flex",justifyContent:"space-between",
              padding:"8px 0 4px",fontSize:"0.82rem",fontWeight:800,
              borderTop:`2px solid ${C.border}`,marginTop:"4px"}}>
              <span style={{flex:2,color:C.forest}}>TOTAL</span>
              <span style={{flex:1,textAlign:"center",color:C.ok}}>
                {detail.summary.reduce((s,w)=>s+(w.present||0),0)}✓</span>
              <span style={{flex:1,textAlign:"center",color:C.danger}}>
                {detail.summary.reduce((s,w)=>s+(w.absent||0),0)}✗</span>
              <span style={{flex:1,textAlign:"right",color:C.gold}}>
                GH₵{detail.summary.reduce((s,w)=>s+(w.chopMoney||0),0).toFixed(0)}</span>
            </div>
          )}

          {detail.status==="pending"&&(
            <Btn onClick={async()=>{
              await updateDoc(doc(db,"attendanceReports",detail.id),{
                status:"approved",
                approvedBy:user?.name||user?.username||"HR",
                approvedAt:serverTimestamp()
              });
              showToast("✅ Acknowledged & Filed!"); setDetail(null);
            }} color={C.ok}
              style={{width:"100%",justifyContent:"center",marginTop:"12px"}}>
              ✓ Acknowledge & File</Btn>
          )}
        </Modal>
      )}
    </div>
  );
}

// ─── REPORTS ──────────────────────────────────────────────────────────────────
function ReportsModule({user}){
  const [period,setPeriod]=useState("daily");
  const [cf,setCf]=useState(today()); const [ct,setCt]=useState(today());
  const [data,setData]=useState({lubes:[],storeItems:[],lubeTx:[],
    storeTx:[],reqs:[],receipts:[]});
  const [loading,setLoading]=useState(true);

  const getRange=()=>{
    const now=new Date();
    if(period==="daily"){const d=today();return{from:d,to:d};}
    if(period==="weekly"){const d=new Date(now);d.setDate(d.getDate()-7);
      return{from:d.toISOString().split("T")[0],to:today()};}
    if(period==="monthly"){return{from:`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`,to:today()};}
    if(period==="annual"){return{from:`${now.getFullYear()}-01-01`,to:`${now.getFullYear()}-12-31`};}
    return{from:cf,to:ct};
  };

  useEffect(()=>{
    setLoading(true);
    Promise.all([
      getDocs(collection(db,"lubricants")),
      getDocs(collection(db,"storeItems")),
      getDocs(query(collection(db,"transactions"),where("type","==","lube"))),
      getDocs(query(collection(db,"transactions"),where("type","==","store"))),
      getDocs(collection(db,"requisitions")),
      getDocs(collection(db,"receipts")),
    ]).then(([l,i,lt,st,r,rc])=>{
      setData({
        lubes:l.docs.map(d=>({id:d.id,...d.data()})),
        storeItems:i.docs.map(d=>({id:d.id,...d.data()})),
        lubeTx:lt.docs.map(d=>({id:d.id,...d.data()})),
        storeTx:st.docs.map(d=>({id:d.id,...d.data()})),
        reqs:r.docs.map(d=>({id:d.id,...d.data()})),
        receipts:rc.docs.map(d=>({id:d.id,...d.data()})),
      });
      setLoading(false);
    }).catch(()=>setLoading(false));
  },[period,cf,ct]);

  const {from,to}=getRange();
  const inR=t=>{const d=tsToStr(t.createdAt);return d>=from&&d<=to;};
  const lubeTx=data.lubeTx.filter(inR);
  const storeTx=data.storeTx.filter(inR);
  const reqs=data.reqs.filter(inR);
  const receipts=data.receipts.filter(inR);
  const lubeIssued=lubeTx.filter(t=>t.action==="issue");
  const storeIssued=storeTx.filter(t=>t.action==="issue");
  const lowLubes=data.lubes.filter(l=>(l.currentStock||0)<(l.minStock||0));
  const lowStore=data.storeItems.filter(i=>(i.currentStock||0)<(i.minStock||0));
  const deptMap={};
  [...lubeIssued,...storeIssued].forEach(t=>{
    if(t.dept) deptMap[t.dept]=(deptMap[t.dept]||0)+1;
  });
  const totalAmt=receipts.reduce((s,r)=>s+parseFloat(r.amount||0),0);
  const maxD=Math.max(...Object.values(deptMap),1);

  const buildReport=()=>{
    const pLabel={daily:"Daily",weekly:"Weekly",monthly:"Monthly",annual:"Annual",custom:"Custom"}[period];
    let t=`KETE KRACHI TIMBER RECOVERY\nSTORES ${pLabel.toUpperCase()} REPORT\n${
      from===to?new Date(from+"T12:00:00").toLocaleDateString("en-GB",
        {day:"2-digit",month:"long",year:"numeric"})
      :`${new Date(from+"T12:00:00").toLocaleDateString("en-GB")} – ${
        new Date(to+"T12:00:00").toLocaleDateString("en-GB")}`}\n\n`;
    t+=`${"─".repeat(40)}\nLUBRICANTS\n${"─".repeat(40)}\n`;
    t+=`Issued: ${lubeIssued.reduce((s,x)=>s+(x.qty||0),0)} Litres (${lubeIssued.length} transactions)\n`;
    t+=`Restocked: ${lubeTx.filter(x=>x.action==="restock").reduce((s,x)=>s+(x.qty||0),0)} Litres\n\nCurrent Stock:\n`;
    data.lubes.forEach(l=>t+=`  ${l.name}: ${l.currentStock||0} ${l.unit}${
      (l.currentStock||0)<(l.minStock||0)?" ⚠ LOW":""}\n`);
    t+=`\n${"─".repeat(40)}\nGENERAL STORES\n${"─".repeat(40)}\n`;
    t+=`Items Issued: ${storeIssued.length} | Restocked: ${storeTx.filter(x=>x.action==="restock").length}\n`;
    t+=`\n${"─".repeat(40)}\nRESTOCK NEEDED\n${"─".repeat(40)}\n`;
    if(!lowLubes.length&&!lowStore.length) t+=`All items adequately stocked.\n`;
    lowLubes.forEach(l=>t+=`⚠ ${l.name}: ${l.currentStock||0} (min ${l.minStock})\n`);
    lowStore.forEach(i=>t+=`⚠ ${i.name}: ${i.currentStock||0} (min ${i.minStock})\n`);
    t+=`\n${"─".repeat(40)}\nDEPARTMENT ACTIVITY\n${"─".repeat(40)}\n`;
    Object.entries(deptMap).sort((a,b)=>b[1]-a[1]).forEach(([d,c])=>t+=`${d}: ${c}\n`);
    t+=`\nREQUISITIONS: ${reqs.length} | Approved: ${reqs.filter(r=>r.status==="approved").length}\n`;
    t+=`RECEIPTS: ${receipts.length} | Total: GH₵${totalAmt.toFixed(2)}\n`;
    t+=`\n${"─".repeat(40)}\nAbraham Sackey\nStores Manager\nKete Krachi Timber Recovery\nGenerated: ${new Date().toLocaleString()}\n`;
    return t;
  };

  const share=via=>{
    const txt=buildReport();
    if(via==="whatsapp") window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`,"_blank");
    else if(via==="email") window.open(`mailto:?subject=KKTR Stores Report&body=${encodeURIComponent(txt)}`,"_blank");
    else navigator.clipboard?.writeText(txt).then(()=>alert("Copied!"));
  };

  if(loading) return <div style={{textAlign:"center",color:"#aaa",padding:"60px"}}>Loading…</div>;

  return(
    <div style={{padding:"0 12px 80px"}}>
      <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest,
        marginBottom:"12px",paddingTop:"4px"}}>📊 Reports & Analytics</div>
      <Card>
        <div style={{fontSize:"0.72rem",fontWeight:700,color:C.forest,
          textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:"8px"}}>
          Report Period</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:"6px"}}>
          {[["daily","Today"],["weekly","Week"],["monthly","Month"],
            ["annual","Year"],["custom","Custom"]].map(([id,l])=>(
            <button key={id} onClick={()=>setPeriod(id)} style={{padding:"7px 12px",
              border:`2px solid ${period===id?C.forest:C.border}`,borderRadius:"8px",
              background:period===id?C.forest:"transparent",
              color:period===id?C.white:C.timber,fontFamily:"inherit",
              fontWeight:700,fontSize:"0.8rem",cursor:"pointer"}}>{l}</button>
          ))}
        </div>
        {period==="custom"&&(
          <div style={{display:"flex",gap:"8px",marginTop:"10px"}}>
            <input type="date" value={cf} onChange={e=>setCf(e.target.value)}
              style={{flex:1,padding:"8px",border:`1.5px solid ${C.border}`,borderRadius:"8px",fontSize:"0.85rem"}}/>
            <input type="date" value={ct} onChange={e=>setCt(e.target.value)}
              style={{flex:1,padding:"8px",border:`1.5px solid ${C.border}`,borderRadius:"8px",fontSize:"0.85rem"}}/>
          </div>
        )}
      </Card>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginBottom:"10px"}}>
        {[
          {icon:"🛢",l:"Lubes Issued",v:lubeIssued.length,
            s:`${lubeIssued.reduce((s,t)=>s+(t.qty||0),0)} L`,c:C.timber},
          {icon:"📦",l:"Items Issued",v:storeIssued.length,s:"transactions",c:C.sage},
          {icon:"📋",l:"Requisitions",v:reqs.length,
            s:`${reqs.filter(r=>r.status==="pending").length} pending`,c:C.warn},
          {icon:"🧾",l:"Receipts",v:receipts.length,s:`GH₵${totalAmt.toFixed(2)}`,c:C.gold},
        ].map((s,i)=>(
          <Card key={i} style={{marginBottom:0}}>
            <div style={{fontSize:"1.5rem",marginBottom:"2px"}}>{s.icon}</div>
            <div style={{fontSize:"1.4rem",fontWeight:800,color:s.c,lineHeight:1}}>{s.v}</div>
            <div style={{fontSize:"0.72rem",fontWeight:700,color:C.timber,textTransform:"uppercase"}}>{s.l}</div>
            <div style={{fontSize:"0.65rem",color:"#aaa"}}>{s.s}</div>
          </Card>
        ))}
      </div>
      {(lowLubes.length+lowStore.length)>0&&(
        <Card style={{border:`1.5px solid ${C.gold}`,marginBottom:"10px"}}>
          <div style={{fontWeight:800,color:C.gold,marginBottom:"8px"}}>⚠ Restock List</div>
          {lowLubes.map(l=><div key={l.id} style={{fontSize:"0.82rem",color:C.bark,
            padding:"3px 0",borderBottom:`1px dashed ${C.border}`}}>
            🛢 {l.name}: {l.currentStock||0}/{l.minStock}</div>)}
          {lowStore.map(i=><div key={i.id} style={{fontSize:"0.82rem",color:C.bark,
            padding:"3px 0",borderBottom:`1px dashed ${C.border}`}}>
            📦 {i.name}: {i.currentStock||0}/{i.minStock}</div>)}
        </Card>
      )}
      {Object.keys(deptMap).length>0&&(
        <Card style={{marginBottom:"10px"}}>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"10px"}}>Department Activity</div>
          {Object.entries(deptMap).sort((a,b)=>b[1]-a[1]).map(([d,count])=>(
            <div key={d} style={{marginBottom:"8px"}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:"0.82rem",marginBottom:"3px"}}>
                <span style={{fontWeight:700,color:C.timber}}>{d}</span>
                <span style={{fontWeight:800,color:C.forest}}>{count}</span>
              </div>
              <div style={{height:"6px",background:"#eee",borderRadius:"3px"}}>
                <div style={{height:"6px",borderRadius:"3px",background:C.sage,
                  width:`${(count/maxD)*100}%`}}/>
              </div>
            </div>
          ))}
        </Card>
      )}
      <Card>
        <div style={{fontWeight:800,color:C.forest,marginBottom:"10px"}}>📤 Share Report</div>
        <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
          <Btn onClick={()=>share("whatsapp")} color="#25D366"
            style={{flex:1,justifyContent:"center"}}>📱 WhatsApp</Btn>
          <Btn onClick={()=>share("email")} color={C.timber}
            style={{flex:1,justifyContent:"center"}}>✉ Email</Btn>
          <Btn onClick={()=>share("copy")} color={C.sage}
            style={{flex:1,justifyContent:"center"}}>📋 Copy</Btn>
        </div>
        <div style={{marginTop:"10px",padding:"8px",background:C.mist,
          borderRadius:"8px",fontSize:"0.72rem",color:C.sage}}>
          Signed: Abraham Sackey, Stores Manager</div>
      </Card>
    </div>
  );
}

// ─── AI ───────────────────────────────────────────────────────────────────────
function AIModule({user}){
  const [msgs,setMsgs]=useState([{role:"assistant",text:
    "Hello! I'm your KKTR AI assistant.\nAsk about stock, restock alerts, or pending requisitions."}]);
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [online,setOnline]=useState(navigator.onLine);
  const bottomRef=useRef(null);

  // Cache data to avoid repeated Firestore reads
  const cache=useRef({lubes:[],items:[],reqs:[]});

  useEffect(()=>{
    const on=()=>setOnline(true); const of2=()=>setOnline(false);
    window.addEventListener("online",on); window.addEventListener("offline",of2);
    // Load data into cache once via listeners
    const uL=onSnapshot(collection(db,"lubricants"),
      s=>{ cache.current.lubes=s.docs.map(d=>({id:d.id,...d.data()})); });
    const uI=onSnapshot(collection(db,"storeItems"),
      s=>{ cache.current.items=s.docs.map(d=>({id:d.id,...d.data()})); });
    const uR=onSnapshot(query(collection(db,"requisitions"),where("status","==","pending")),
      s=>{ cache.current.reqs=s.docs.map(d=>({id:d.id,...d.data()})); });
    return()=>{
      window.removeEventListener("online",on);
      window.removeEventListener("offline",of2);
      uL(); uI(); uR();
    };
  },[]);

  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:"smooth"});},[msgs]);

  // Intent detection — smarter than .includes()
  const detectIntent=(q)=>{
    if(/low|restock|below|running.?out|shortage/i.test(q)) return "restock";
    if(/stock|inventory|available|how.?much|quantity/i.test(q)) return "stock";
    if(/requisition|pending|request|approval/i.test(q)) return "reqs";
    if(/predict|forecast|soon|days|risk/i.test(q)) return "predict";
    return "general";
  };

  const getLocal=(q)=>{
    const intent=detectIntent(q);
    const lubes=cache.current.lubes;
    const items=cache.current.items;
    const reqs=cache.current.reqs;
    const lowL=lubes.filter(l=>(l.currentStock||0)<(l.minStock||0));
    const lowI=items.filter(i=>(i.currentStock||0)<(i.minStock||0));

    if(intent==="restock"){
      if(!lowL.length&&!lowI.length) return "✅ All stock levels are above minimum.";
      let r="⚠ Restock Needed:\n\n";
      lowL.forEach(l=>r+=`🛢 ${l.name}: ${l.currentStock||0} ${l.unit} (min ${l.minStock})\n`);
      lowI.forEach(i=>r+=`📦 ${i.name}: ${i.currentStock||0} (min ${i.minStock})\n`);
      return r;
    }
    if(intent==="stock"){
      let r="📊 Current Stock:\n\n🛢 Lubricants:\n";
      lubes.forEach(l=>r+=`  ${l.name}: ${l.currentStock||0} ${l.unit}${
        (l.currentStock||0)<(l.minStock||0)?" ⚠ LOW":""}\n`);
      r+=`\n📦 Store Items: ${items.length} tracked\n`;
      if(lowL.length+lowI.length>0)
        r+=`\n⚠ ${lowL.length+lowI.length} items need restocking`;
      return r;
    }
    if(intent==="reqs"){
      if(!reqs.length) return "✅ No pending requisitions.";
      let r=`📋 ${reqs.length} Pending Requisition${reqs.length>1?"s":""}:\n\n`;
      reqs.forEach(x=>r+=`• ${x.item} — ${x.dept} (${x.qty} ${x.unit||""})\n`);
      return r;
    }
    if(intent==="predict"){
      // Basic risk prediction
      const atRisk=lubes.filter(l=>(l.currentStock||0)<(l.minStock||0)*1.5);
      if(!atRisk.length) return "✅ No stock at risk of running out soon.";
      let r="⚠ Stock At Risk Soon:\n\n";
      atRisk.forEach(l=>r+=`🛢 ${l.name}: ${l.currentStock||0} ${l.unit} (may run out soon)\n`);
      return r;
    }
    // Only call Claude API if local can't answer
    return null;
  };

  const send=async()=>{
    if(!input.trim()||loading) return;
    const q=input.trim();
    setMsgs(m=>[...m,{role:"user",text:q}]);
    setInput(""); setLoading(true);
    try {
      // Local first — free and instant
      const local=getLocal(q);
      if(local){
        setMsgs(m=>[...m,{role:"assistant",
          text:local+(!online?"\n\n📡 Offline mode":"")}]);
        setLoading(false); return;
      }
      // Offline fallback
      if(!online){
        setMsgs(m=>[...m,{role:"assistant",
          text:"📡 You're offline. Ask about stock, restock, or requisitions."}]);
        setLoading(false); return;
      }
      // Claude API — uses cached data, not fresh reads
      const lubes=cache.current.lubes;
      const items=cache.current.items;
      const sys=`You are a store assistant for Kete Krachi Timber Recovery (Ghana).
Help ${user?.name||"User"}.

Lubricants: ${JSON.stringify(lubes.map(l=>({name:l.name,qty:l.currentStock||0,unit:l.unit,min:l.minStock})))}
Store Items (top 10): ${JSON.stringify(items.slice(0,10).map(i=>({name:i.name,qty:i.currentStock||0})))}

Rules: Be concise. Focus on inventory insights. Reply in plain text.`;

      const history=msgs.slice(-4).map(m=>({
        role:m.role==="assistant"?"assistant":"user",content:m.text}));
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "anthropic-version":"2023-06-01",
          "anthropic-dangerous-allow-browser":"true"
        },
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:600,
          system:sys,messages:[...history,{role:"user",content:q}]
        })
      });
      if(!res.ok) throw new Error("AI request failed ("+res.status+")");
      const dat=await res.json();
      const text=dat?.content?.[0]?.text||dat?.content?.find(b=>b?.type==="text")?.text||"No response.";
      setMsgs(m=>[...m,{role:"assistant",text}]);
    } catch(e){
      setMsgs(m=>[...m,{role:"assistant",
        text:"⚠ "+e.message+"\nTry: 'What needs restocking?' or 'Stock summary'"}]);
    }
    setLoading(false);
  };

  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 116px)",padding:"0 12px",overflow:"hidden"}}>
      <div style={{display:"flex",justifyContent:"space-between",
        alignItems:"center",paddingTop:"4px",marginBottom:"10px"}}>
        <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest}}>🤖 AI Assistant</div>
        <Badge color={online?C.ok:C.warn}>{online?"Online":"Offline"}</Badge>
      </div>
      <div style={{flex:1,overflowY:"auto",paddingBottom:"8px"}}>
        {msgs.map((m,i)=>(
          <div key={i} style={{display:"flex",
            justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:"10px"}}>
            <div style={{maxWidth:"85%",
              background:m.role==="user"?C.forest:C.white,
              color:m.role==="user"?C.cream:C.ink,
              borderRadius:m.role==="user"?"16px 16px 4px 16px":"16px 16px 16px 4px",
              padding:"10px 14px",fontSize:"0.86rem",lineHeight:"1.5",
              boxShadow:"0 2px 8px rgba(26,46,26,0.1)",
              border:m.role==="user"?"none":`1px solid ${C.border}`,
              whiteSpace:"pre-wrap"}}>{m.text}</div>
          </div>
        ))}
        {loading&&<div style={{display:"flex",justifyContent:"flex-start",marginBottom:"10px"}}>
          <div style={{background:C.white,border:`1px solid ${C.border}`,
            borderRadius:"16px 16px 16px 4px",padding:"12px 16px",color:"#999"}}>
            thinking…</div></div>}
        <div ref={bottomRef}/>
      </div>
      {msgs.length<=1&&(
        <div style={{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"8px"}}>
          {["What needs restocking?","Pending requisitions","Stock summary"].map(s=>(
            <button key={s} onClick={()=>setInput(s)} style={{background:C.mist,
              border:`1px solid ${C.border}`,borderRadius:"20px",padding:"6px 12px",
              fontSize:"0.78rem",cursor:"pointer",color:C.forest,fontWeight:600,
              fontFamily:"inherit"}}>{s}</button>
          ))}
        </div>
      )}
      <div style={{display:"flex",gap:"8px",paddingBottom:"4px",paddingTop:"6px",
        paddingLeft:"12px",paddingRight:"12px",
        position:"sticky",bottom:0,background:C.cream}}>
        <input value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&send()}
          placeholder="Ask about stock, alerts…"
          style={{flex:1,padding:"11px 16px",border:`1.5px solid ${C.border}`,
            borderRadius:"30px",fontSize:"0.88rem",fontFamily:"inherit",
            outline:"none",background:C.white}}/>
        <button onClick={send} disabled={loading||!input.trim()}
          style={{background:loading||!input.trim()?C.border:C.forest,
            border:"none",borderRadius:"50%",width:"44px",height:"44px",
            cursor:loading||!input.trim()?"not-allowed":"pointer",
            display:"flex",alignItems:"center",justifyContent:"center",
            color:C.white,flexShrink:0,fontSize:"1.1rem"}}>➤</button>
      </div>
    </div>
  );
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function SettingsModule({user,onLogout,onInstall}){
  const [tab,setTab]=useState("profile");
  const [toastEl,showToast]=useToast();
  const [users,setUsers]=useState([]);
  const [pwdResets,setPwdResets]=useState([]);
  const [resetTarget,setResetTarget]=useState(null);
  const [newPwd,setNewPwd]=useState("");
  const [myOldPwd,setMyOldPwd]=useState("");
  const [myNewPwd,setMyNewPwd]=useState("");
  const [factoryPwd,setFactoryPwd]=useState("");
  const [loading,setLoading]=useState(false);
  const [logo,setLogo]=useState(null);
  const [logoLoading,setLogoLoading]=useState(false);

  useEffect(()=>{
    if(user.role!=="admin") return;
    const uU=onSnapshot(collection(db,"users"),s=>setUsers(s.docs.map(d=>({id:d.id,...d.data()}))));
    const uP=onSnapshot(query(collection(db,"passwordResets"),where("status","==","pending")),
      s=>setPwdResets(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDoc(doc(db,"settings","company"))
      .then(s=>{ if(s.exists()&&s.data().logoUrl) setLogo(s.data().logoUrl); }).catch(()=>{});
    return()=>{uU();uP();};
  },[user]);

  const approveUser=async(id)=>{
    await updateDoc(doc(db,"users",id),{approved:true});
    showToast("✅ Account approved!");
  };
  const deleteUser=async(id,name)=>{
    if(!window.confirm(`Delete account for ${name}?`)) return;
    await deleteDoc(doc(db,"users",id));
    showToast("Account deleted.");
  };
  const resetPwd=async(target)=>{
    if(!newPwd||newPwd.length<6) return showToast("Min 6 characters","warn");
    setLoading(true);
    try {
      // Hash the new password before storing — never store plain text
      const newHash=await hashPwd(newPwd);
      await updateDoc(doc(db,"users",target.id),{
        pwdHash:newHash,
        pendingPasswordReset:null,
        passwordResetBy:user?.name||user?.username||"Admin",
        passwordResetAt:serverTimestamp()
      });
      const rSnap=await getDocs(query(collection(db,"passwordResets"),
        where("userId","==",target.id),where("status","==","pending")));
      for(const d of rSnap.docs)
        await updateDoc(doc(db,"passwordResets",d.id),{status:"completed"});
      showToast(`✅ Password for ${target.name||target.username} reset!`);
      setResetTarget(null); setNewPwd("");
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };
  const changeMyPwd=async()=>{
    if(!myOldPwd||!myNewPwd) return showToast("Fill both fields","warn");
    if(myNewPwd.length<6) return showToast("Min 6 characters","warn");
    setLoading(true);
    try {
      const oldHash=await hashPwd(myOldPwd);
      const snap=await getDoc(doc(db,"users",user.username));
      if(!snap.exists()||snap.data().pwdHash!==oldHash){
        showToast("Current password is wrong","danger"); setLoading(false); return;
      }
      const newHash=await hashPwd(myNewPwd);
      await updateDoc(doc(db,"users",user.username),{pwdHash:newHash});
      Sess.save({...user,pwdHash:newHash});
      showToast("✅ Password changed!");
      setMyOldPwd(""); setMyNewPwd("");
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };
  const handleLogo=async(e)=>{
    const file=e.target.files[0]; if(!file) return;
    setLogoLoading(true);
    showToast("Uploading logo…","warn");
    try {
      const reader=new FileReader();
      reader.onload=async(ev)=>{
        try {
          // Compress image using canvas before upload
          const img=new Image();
          img.onload=async()=>{
            const MAX=300; // max 300px — small enough to be fast
            const canvas=document.createElement("canvas");
            const ratio=Math.min(MAX/img.width, MAX/img.height, 1);
            canvas.width=img.width*ratio;
            canvas.height=img.height*ratio;
            const ctx=canvas.getContext("2d");
            ctx.drawImage(img,0,0,canvas.width,canvas.height);
            // Compress to JPEG at 80% quality
            const compressed=canvas.toDataURL("image/jpeg",0.8);

            // Convert base64 to Blob for uploadBytes
            let logoUrl=null;
            try {
              const res=await fetch(compressed);
              const blob=await res.blob();
              const imgRef=sRef(storage,"settings/logo.jpg");
              await uploadBytes(imgRef,blob,{contentType:"image/jpeg"});
              logoUrl=await getDownloadURL(imgRef);
            } catch(storageErr){
              // Storage failed — save compressed base64 directly to Firestore
              logoUrl=compressed;
            }

            await setDoc(doc(db,"settings","company"),{logoUrl},{merge:true});
            setLogo(logoUrl);
            showToast("✅ Logo saved!");
            setLogoLoading(false);
          };
          img.onerror=()=>{
            showToast("Invalid image file","danger");
            setLogoLoading(false);
          };
          img.src=ev.target.result;
        } catch(e2){
          showToast("Upload failed: "+e2.message,"danger");
          setLogoLoading(false);
        }
      };
      reader.onerror=()=>{
        showToast("Could not read file","danger");
        setLogoLoading(false);
      };
      reader.readAsDataURL(file);
    } catch(e){ showToast("Failed: "+e.message,"danger"); setLogoLoading(false); }
  };
  const seedLubes=async()=>{
    const existing=await getDocs(collection(db,"lubricants"));
    if(existing.size>0){ showToast("Lubricants already exist","warn"); return; }
    for(const l of DEF_LUBES)
      await addDoc(collection(db,"lubricants"),{...l,currentStock:0,createdAt:serverTimestamp()});
    showToast("✅ Default lubricants added!");
  };
  const factoryReset=async()=>{
    if(!factoryPwd){ showToast("Enter admin password","warn"); return; }
    const hash=await hashPwd(factoryPwd);
    const snap=await getDoc(doc(db,"users",ADMIN_USER));
    if(!snap.exists()||snap.data().pwdHash!==hash){
      showToast("Wrong admin password","danger"); return;
    }
    if(!window.confirm("⚠ Clear ALL transactions, requisitions, attendance and receipts?")) return;
    setLoading(true);
    try {
      // Main collections
      for(const col of ["transactions","requisitions","receipts","chopMoney",
        "attendanceReports","attendance","passwordResets",
        "notifications","requisitionHistory"]){
        const s=await getDocs(collection(db,col));
        for(const d of s.docs) await deleteDoc(doc(db,col,d.id));
      }
      // Clear chat subcollections per department
      for(const dept of DEPTS){
        try {
          const msgs=await getDocs(collection(db,"chats",dept,"messages"));
          for(const d of msgs.docs) await deleteDoc(d.ref);
        } catch(e2){}
      }
      showToast("✅ Factory reset complete.");
      setFactoryPwd("");
    } catch(e){ showToast("Failed: "+e.message,"danger"); }
    setLoading(false);
  };

  const pending=users.filter(u=>!u.approved&&u.role==="dept");
  const active=users.filter(u=>u.approved&&u.role!=="admin");
  const adminTabs=user.role==="admin"
    ?[{id:"profile",label:"Profile"},{id:"accounts",label:"Accounts"},
      {id:"logo",label:"Logo"},{id:"import",label:"Import"},{id:"setup",label:"Setup"}]
    :[{id:"profile",label:"Profile"}];

  return(
    <div style={{padding:"0 12px 80px"}}>
      {toastEl}
      <div style={{fontWeight:800,fontSize:"1.2rem",color:C.forest,
        marginBottom:"12px",paddingTop:"4px"}}>⚙ Settings</div>
      <Card style={{marginBottom:"12px"}}>
        <div style={{display:"flex",gap:"12px",alignItems:"center",marginBottom:"12px"}}>
          <div style={{width:"48px",height:"48px",borderRadius:"50%",background:C.gold,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:"1.4rem",flexShrink:0}}>👤</div>
          <div>
            <div style={{fontWeight:800,color:C.forest}}>{user?.name||user?.username||"User"}</div>
            <div style={{fontSize:"0.8rem",color:C.timber}}>
              {user.role==="admin"?"System Administrator":
               user.dept==="HR"?"HR Department":"Dept. Head"} · {user.dept}</div>
            <div style={{fontSize:"0.72rem",color:"#aaa"}}>@{user.username}</div>
          </div>
        </div>
        <Btn onClick={onLogout} outline color={C.danger}
          style={{width:"100%",justifyContent:"center"}}>Sign Out</Btn>
        {onInstall&&(
          <Btn onClick={onInstall} color={C.gold}
            style={{width:"100%",justifyContent:"center",marginTop:"8px"}}>
            📲 Install App on This Device</Btn>
        )}
        {!onInstall&&(
          <div style={{marginTop:"8px",padding:"8px",background:C.mist,
            borderRadius:"8px",fontSize:"0.72rem",color:C.timber,lineHeight:1.6}}>
            📲 Install: Chrome menu (⋮) → Add to Home Screen
          </div>
        )}
      </Card>
      <TabBar tabs={adminTabs} active={tab} onSelect={setTab}/>

      {tab==="profile"&&(
        <Card>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"12px"}}>
            🔑 Change My Password</div>
          <Inp label="Current Password *" type="password" value={myOldPwd}
            onChange={e=>setMyOldPwd(e.target.value)}/>
          <Inp label="New Password *" type="password" value={myNewPwd}
            onChange={e=>setMyNewPwd(e.target.value)} placeholder="Min 6 characters"/>
          <Btn onClick={changeMyPwd} loading={loading}
            style={{width:"100%",justifyContent:"center"}}>Change Password</Btn>
        </Card>
      )}

      {tab==="accounts"&&user.role==="admin"&&(
        <div>
          {pwdResets.length>0&&(
            <Card style={{border:`1.5px solid ${C.gold}`,marginBottom:"10px"}}>
              <div style={{fontWeight:800,color:C.gold,marginBottom:"10px"}}>
                🔑 Password Reset Requests ({pwdResets.length})</div>
              {pwdResets.map(r=>(
                <div key={r.id} style={{padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
                  <div style={{fontWeight:700,color:C.forest}}>{r.name}</div>
                  <div style={{fontSize:"0.72rem",color:"#888"}}>
                    @{r.username} · {r.dept}</div>
                  {resetTarget?.id===r.userId?(
                    <div style={{marginTop:"8px",display:"flex",gap:"6px"}}>
                      <input value={newPwd} onChange={e=>setNewPwd(e.target.value)}
                        type="password" placeholder="New password (min 6)"
                        style={{flex:1,padding:"8px",border:`1.5px solid ${C.border}`,
                          borderRadius:"8px",fontFamily:"inherit",fontSize:"0.85rem"}}/>
                      <Btn sm onClick={()=>resetPwd(resetTarget)} color={C.ok} loading={loading}>Set</Btn>
                      <Btn sm onClick={()=>setResetTarget(null)} outline color={C.danger}>✕</Btn>
                    </div>
                  ):(
                    <Btn sm onClick={()=>setResetTarget({id:r.userId,name:r.name})}
                      style={{marginTop:"6px"}}>Set New Password</Btn>
                  )}
                </div>
              ))}
            </Card>
          )}
          {pending.length>0&&(
            <Card style={{border:`1.5px solid ${C.gold}`,marginBottom:"10px"}}>
              <div style={{fontWeight:800,color:C.gold,marginBottom:"10px"}}>
                🔔 Pending Approval ({pending.length})</div>
              {pending.map(u=>(
                <div key={u.id} style={{padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
                  <div style={{fontWeight:700,color:C.forest}}>{u.name}</div>
                  <div style={{fontSize:"0.72rem",color:"#888"}}>@{u.username} · {u.dept}</div>
                  <div style={{display:"flex",gap:"6px",marginTop:"6px"}}>
                    <Btn sm onClick={()=>approveUser(u.id)} color={C.ok}
                      style={{flex:1,justifyContent:"center"}}>✓ Approve</Btn>
                    <Btn sm onClick={()=>deleteUser(u.id,u.name)} color={C.danger}
                      style={{flex:1,justifyContent:"center"}}>✗ Reject</Btn>
                  </div>
                </div>
              ))}
            </Card>
          )}
          <Card>
            <div style={{fontWeight:800,color:C.forest,marginBottom:"10px"}}>
              👥 Active Accounts</div>
            {active.map(u=>(
              <div key={u.id} style={{padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:"0.86rem",color:C.forest}}>{u.name}</div>
                    <div style={{fontSize:"0.72rem",color:"#999"}}>
                      @{u.username} · {u.dept}</div>
                    <Badge color={
                      u.role==="store_manager"?C.gold:
                      u.role==="hr"?C.blue:C.sage}>
                      {u.role||"dept"}</Badge>
                  </div>
                  <div style={{display:"flex",gap:"4px",flexWrap:"wrap",justifyContent:"flex-end"}}>
                    <select value={u.role||"dept"}
                      onChange={async(e)=>{
                        await updateDoc(doc(db,"users",u.id),{role:e.target.value});
                        showToast(`✅ Role updated to ${e.target.value}`);
                      }}
                      style={{padding:"4px 6px",border:`1px solid ${C.border}`,
                        borderRadius:"6px",fontFamily:"inherit",fontSize:"0.72rem",
                        background:C.white,color:C.forest}}>
                      <option value="dept">Dept Head</option>
                      <option value="store_manager">Store Manager</option>
                      <option value="hr">HR</option>
                      <option value="coo">COO</option>
                      <option value="admin">Admin</option>
                    </select>
                    <Btn sm onClick={()=>{setResetTarget(u);setNewPwd("");}}
                      outline color={C.timber}>🔑</Btn>
                    <Btn sm onClick={()=>deleteUser(u.id,u.name)} outline color={C.danger}>🗑</Btn>
                  </div>
                </div>
                {resetTarget?.id===u.id&&(
                  <div style={{marginTop:"8px",display:"flex",gap:"6px"}}>
                    <input value={newPwd} onChange={e=>setNewPwd(e.target.value)}
                      type="password" placeholder="New password (min 6)"
                      style={{flex:1,padding:"8px",border:`1.5px solid ${C.border}`,
                        borderRadius:"8px",fontFamily:"inherit",fontSize:"0.85rem"}}/>
                    <Btn sm onClick={()=>resetPwd(u)} color={C.ok} loading={loading}>Set</Btn>
                    <Btn sm onClick={()=>setResetTarget(null)} outline color={C.danger}>✕</Btn>
                  </div>
                )}
              </div>
            ))}
            {active.length===0&&<div style={{fontSize:"0.82rem",color:"#aaa"}}>
              No accounts registered yet.</div>}
          </Card>
        </div>
      )}

      {tab==="logo"&&user.role==="admin"&&(
        <Card>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"10px"}}>🖼 Company Logo</div>
          {logo&&<img src={logo} alt="logo" style={{width:"80px",height:"80px",
            borderRadius:"50%",objectFit:"cover",display:"block",
            margin:"0 auto 12px",border:`3px solid ${C.gold}`}}/>}
          <label style={{display:"flex",flexDirection:"column",alignItems:"center",
            justifyContent:"center",background:C.mist,border:`2px dashed ${C.border}`,
            borderRadius:"10px",padding:"16px",cursor:"pointer"}}>
            {logoLoading?<div>Uploading…</div>
              :<><div style={{fontSize:"2rem"}}>📷</div>
                <span style={{fontWeight:700,color:C.forest,fontSize:"0.88rem"}}>
                  {logo?"Change Logo":"Upload Company Logo"}</span>
                <span style={{fontSize:"0.72rem",color:"#888",marginTop:"4px"}}>
                  Syncs to ALL devices</span></>}
            <input type="file" accept="image/*" onChange={handleLogo} style={{display:"none"}}/>
          </label>
        </Card>
      )}

      {tab==="import"&&user.role==="admin"&&(
        <Card>
          <div style={{fontWeight:800,color:C.forest,marginBottom:"8px"}}>
            📥 Import Store Items from CSV</div>
          <label style={{display:"flex",flexDirection:"column",alignItems:"center",
            justifyContent:"center",background:C.mist,border:`2px dashed ${C.border}`,
            borderRadius:"10px",padding:"16px",cursor:"pointer"}}>
            <div style={{fontSize:"2rem"}}>📂</div>
            <span style={{fontWeight:700,color:C.forest}}>Choose CSV File</span>
            <input type="file" accept=".csv,.txt" onChange={async(e)=>{
              const file=e.target.files[0]; if(!file) return;
              const reader=new FileReader();
              reader.onload=async(ev)=>{
                try {
                  const lines=ev.target.result.split("\n").filter(l=>l.trim());
                  if(lines.length<2) return showToast("File empty","warn");
                  const headers=lines[0].split(",").map(h=>h.trim().toLowerCase().replace(/"/g,""));
                  const ni=headers.findIndex(h=>h.includes("name")||h.includes("item"));
                  if(ni<0) return showToast("No 'name' column found","warn");
                  const ui=headers.findIndex(h=>h.includes("unit"));
                  const mi=headers.findIndex(h=>h.includes("min"));
                  const ci=headers.findIndex(h=>h.includes("cat"));
                  const qi=headers.findIndex(h=>h.includes("qty")||h.includes("stock"));
                  let count=0;
                  for(let i=1;i<lines.length;i++){
                    const cols=lines[i].split(",").map(c=>c.trim().replace(/"/g,""));
                    if(!cols[ni]) continue;
                    await addDoc(collection(db,"storeItems"),{
                      name:cols[ni],unit:ui>=0?cols[ui]||"pcs":"pcs",
                      category:ci>=0?cols[ci]||"General":"General",
                      minStock:mi>=0?parseFloat(cols[mi])||0:0,
                      currentStock:qi>=0?parseFloat(cols[qi])||0:0,
                      createdAt:serverTimestamp()
                    });
                    count++;
                  }
                  showToast(`✅ Imported ${count} items!`);
                  e.target.value="";
                } catch(err){ showToast("Import error: "+err.message,"danger"); }
              };
              reader.readAsText(file);
            }} style={{display:"none"}}/>
          </label>
          <div style={{marginTop:"10px",padding:"10px",background:"#f9f9f9",
            borderRadius:"8px",fontSize:"0.72rem",color:"#888",lineHeight:1.7}}>
            Format: name,unit,category,minStock,qty
          </div>
        </Card>
      )}

      {tab==="setup"&&user.role==="admin"&&(
        <div>
          <Card>
            <div style={{fontWeight:800,color:C.forest,marginBottom:"8px"}}>🚀 First-Time Setup</div>
            <Btn onClick={seedLubes}
              style={{width:"100%",justifyContent:"center",marginBottom:"8px"}}>
              Add Default Lubricants</Btn>
          </Card>
          <Card style={{border:`1.5px solid ${C.blue}`}}>
            <div style={{fontWeight:800,color:C.blue,marginBottom:"8px"}}>
              🔧 Fix Old Data (Run Once)</div>
            <div style={{fontSize:"0.82rem",color:"#888",marginBottom:"12px"}}>
              Adds missing approverRole to old requisitions so they appear correctly.</div>
            <Btn onClick={async()=>{
              setLoading(true);
              try {
                const snap=await getDocs(collection(db,"requisitions"));
                let fixed=0;
                for(const d of snap.docs){
                  if(!d.data().approverRole){
                    await updateDoc(doc(db,"requisitions",d.id),{approverRole:"admin"});
                    fixed++;
                  }
                }
                showToast(`✅ Fixed ${fixed} old requisitions!`);
              } catch(e){ showToast("Failed: "+e.message,"danger"); }
              setLoading(false);
            }} loading={loading} color={C.blue}
              style={{width:"100%",justifyContent:"center"}}>
              🔧 Migrate Old Requisitions</Btn>
          </Card>
          <Card style={{border:`1.5px solid ${C.warn}`}}>
            <div style={{fontWeight:800,color:C.warn,marginBottom:"8px"}}>
              💬 Clear All Chat Messages</div>
            <div style={{fontSize:"0.82rem",color:"#888",marginBottom:"12px"}}>
              Deletes all messages from all department chats. Fixes stale unread counts.
              Cannot be undone.</div>
            <Btn onClick={async()=>{
              if(!window.confirm("Delete all chat messages from all departments?")) return;
              setLoading(true);
              try {
                for(const dept of DEPTS){
                  const msgs=await getDocs(collection(db,"chats",dept,"messages"));
                  for(const d of msgs.docs) await deleteDoc(d.ref);
                }
                showToast("✅ All chats cleared!");
              } catch(e){ showToast("Failed: "+e.message,"danger"); }
              setLoading(false);
            }} loading={loading} color={C.warn}
              style={{width:"100%",justifyContent:"center"}}>
              🗑 Clear All Chats</Btn>
          </Card>
          <Card style={{border:`1.5px solid ${C.danger}`}}>
            <div style={{fontWeight:800,color:C.danger,marginBottom:"8px"}}>⚠ Factory Reset</div>
            <div style={{fontSize:"0.82rem",color:"#888",marginBottom:"12px"}}>
              Clears all transactions, requisitions, attendance and receipts.
              Accounts and stock items are kept.</div>
            <Inp type="password" value={factoryPwd}
              onChange={e=>setFactoryPwd(e.target.value)}
              placeholder="Enter admin password to confirm"/>
            <Btn onClick={factoryReset} loading={loading} color={C.danger}
              style={{width:"100%",justifyContent:"center"}}>
              Factory Reset (Irreversible)</Btn>
          </Card>
        </div>
      )}

      <Card style={{marginTop:"12px",background:`linear-gradient(135deg,${C.forest},${C.bark})`}}>
        <div style={{fontWeight:800,color:C.cream,fontSize:"1rem"}}>
          Kete Krachi Timber Recovery</div>
        <div style={{fontSize:"0.75rem",color:"rgba(245,237,214,0.7)",marginTop:"4px"}}>
          Store Management System v8.4</div>
        <div style={{fontSize:"0.7rem",color:"rgba(245,237,214,0.4)"}}>
          Built by Anaase-Tech Ltd · {new Date().getFullYear()} ·</div>
      </Card>
    </div>
  );
}

// ─── ERROR BOUNDARY — prevents blank screen on any crash ─────────────────────
class ErrorBoundary extends Component {
  constructor(props){ super(props); this.state={error:null}; }
  static getDerivedStateFromError(e){ return{error:e}; }
  render(){
    if(this.state.error){
      return(
        <div style={{minHeight:"100vh",background:C.forest,display:"flex",
          flexDirection:"column",alignItems:"center",justifyContent:"center",
          padding:"24px",fontFamily:"system-ui"}}>
          <div style={{fontSize:"3rem",marginBottom:"16px"}}>🪵</div>
          <div style={{color:C.cream,fontWeight:800,fontSize:"1.1rem",marginBottom:"8px"}}>
            KKTR Stores</div>
          <div style={{color:C.gold,fontWeight:700,marginBottom:"8px"}}>
            Something went wrong</div>
          <div style={{color:"rgba(245,237,214,0.6)",fontSize:"0.75rem",
            marginBottom:"20px",textAlign:"center",maxWidth:"280px",
            wordBreak:"break-all"}}>
            {this.state.error.message}</div>
          <button onClick={()=>{
            localStorage.clear();
            window.location.reload();
          }} style={{background:C.gold,border:"none",borderRadius:"10px",
            color:C.white,padding:"12px 24px",fontFamily:"inherit",
            fontWeight:800,cursor:"pointer",fontSize:"0.9rem"}}>
            🔄 Reload App
          </button>
          <button onClick={()=>this.setState({error:null})}
            style={{background:"none",border:"none",color:"rgba(245,237,214,0.5)",
              fontFamily:"inherit",cursor:"pointer",marginTop:"10px",
              fontSize:"0.8rem",textDecoration:"underline"}}>
            Try without reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App(){
  return(
    <ErrorBoundary>
      <AppInner/>
    </ErrorBoundary>
  );
}

function AppInner(){
  const [user,setUser]=useState(Sess.load);
  const [tab,setTab]=useState("home");
  const [installPrompt,setInstallPrompt]=useState(null);
  const [showInstall,setShowInstall]=useState(false);

  useEffect(()=>{
    const handler=e=>{ e.preventDefault(); setInstallPrompt(e); setShowInstall(true); };
    window.addEventListener("beforeinstallprompt",handler);
    window.addEventListener("appinstalled",()=>setShowInstall(false));
    return()=>window.removeEventListener("beforeinstallprompt",handler);
  },[]);

  const handleInstall=async()=>{
    if(!installPrompt) return;
    installPrompt.prompt();
    const r=await installPrompt.userChoice;
    if(r.outcome==="accepted") setShowInstall(false);
  };

  const login=u=>{ Sess.save(u); setUser(u); setTab("home"); };
  const logout=()=>{ Sess.clear(); setUser(null); };

  // ─── GLOBAL REAL-TIME NOTIFICATION LISTENER ───────────────────────────────
  useEffect(()=>{
    if(!user) return;
    // Listen for unread notifications addressed to this user
    const q=query(collection(db,"notifications"),
      where("toUserId","==",user.id),
      where("read","==",false));
    const unsub=onSnapshot(q,snap=>{
      snap.docChanges().forEach(change=>{
        if(change.type==="added"){
          const n=change.doc.data();
          // Show toast — mark read immediately to avoid repeat
          updateDoc(doc(db,"notifications",change.doc.id),{read:true}).catch(()=>{});
          // We'll display using a temporary DOM element since toast is per-component
          const el=document.createElement("div");
          el.innerText=`🔔 ${n.message}`;
          Object.assign(el.style,{
            position:"fixed",top:"70px",left:"50%",
            transform:"translateX(-50%)",
            background:"#1a2e1a",color:"#F5EDD6",
            padding:"10px 20px",borderRadius:"30px",
            fontWeight:700,fontSize:"0.88rem",
            zIndex:9999,boxShadow:"0 4px 20px rgba(0,0,0,0.3)",
            maxWidth:"90vw",textAlign:"center",
            animation:"none",opacity:1
          });
          document.body.appendChild(el);
          setTimeout(()=>{ try{document.body.removeChild(el);}catch{} },3500);
        }
      });
    },()=>{});
    return()=>unsub();
  },[user]);

  if(!user) return <AuthScreen onLogin={login}/>;

  const isAdmin=user.role==="admin";
  const isHR=user.role==="hr"; // v8.4 strict

  const adminNav=[
    {id:"home",icon:"🏠",l:"Home"},{id:"lubes",icon:"🛢",l:"Lubes"},
    {id:"stores",icon:"📦",l:"Stores"},{id:"reqs",icon:"📋",l:"Reqs"},
    {id:"receipts",icon:"🧾",l:"Receipts"},{id:"reports",icon:"📊",l:"Reports"},
    {id:"chat",icon:"💬",l:"Chat"},{id:"ai",icon:"🤖",l:"AI"},
    {id:"settings",icon:"⚙",l:"More"},
  ];
  const hrNav=[
    {id:"home",icon:"🏠",l:"Home"},{id:"hr",icon:"👥",l:"HR"},
    {id:"reqs",icon:"📋",l:"Reqs"},{id:"chat",icon:"💬",l:"Chat"},
    {id:"settings",icon:"⚙",l:"Account"},
  ];
  const deptNav=[
    {id:"home",icon:"🏠",l:"Home"},{id:"reqs",icon:"📋",l:"Requests"},
    {id:"attendance",icon:"📅",l:"Attend."},{id:"receipts",icon:"🧾",l:"Receipts"},
    {id:"chat",icon:"💬",l:"Chat"},{id:"settings",icon:"⚙",l:"Account"},
  ];
  const nav=isAdmin?adminNav:isHR?hrNav:deptNav;

  return(
    <div style={{fontFamily:"'Nunito',system-ui,sans-serif",background:C.panel,
      minHeight:"100vh",maxWidth:"480px",margin:"0 auto",position:"relative"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; }
        input:focus, select:focus {
          outline: 2px solid ${C.gold} !important;
          border-color: ${C.gold} !important;
        }
        @keyframes kktr-spin { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{background:`linear-gradient(90deg,${C.forest},${C.bark})`,
        padding:"10px 16px",display:"flex",alignItems:"center",gap:"10px",
        position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 10px rgba(0,0,0,0.2)"}}>
        <div style={{fontSize:"1.3rem"}}>🪵</div>
        <div>
          <div style={{fontSize:"0.9rem",color:C.cream,fontWeight:800,lineHeight:1.1}}>
            KKTR Stores</div>
          <div style={{fontSize:"0.62rem",color:"rgba(245,237,214,0.55)",
            textTransform:"uppercase",letterSpacing:"0.05em"}}>
            {isAdmin?"System Administrator":isHR?"HR Department":user.dept}</div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"8px"}}>
          {showInstall&&(
            <button onClick={handleInstall} style={{background:C.gold,border:"none",
              borderRadius:"8px",color:C.white,fontFamily:"inherit",fontWeight:800,
              fontSize:"0.7rem",padding:"5px 10px",cursor:"pointer"}}>
              📲 Install
            </button>
          )}
          <div style={{display:"flex",alignItems:"center",gap:"4px"}}>
            <div style={{width:"7px",height:"7px",borderRadius:"50%",
              background:navigator.onLine?C.ok:C.warn}}/>
            <span style={{fontSize:"0.65rem",color:"rgba(245,237,214,0.55)"}}>
              {navigator.onLine?"Live":"Offline"}</span>
          </div>
        </div>
      </div>

      <div>
        {tab==="home"&&<Dashboard user={user} onNav={setTab}/>}
        {tab==="lubes"&&<LubesModule user={user}/>}
        {tab==="stores"&&<StoresModule user={user}/>}
        {tab==="reqs"&&<ReqsModule user={user}/>}
        {tab==="attendance"&&<AttendanceModule user={user}/>}
        {tab==="hr"&&<HRModule user={user}/>}
        {tab==="receipts"&&<ReceiptsModule user={user}/>}
        {tab==="reports"&&<ReportsModule user={user}/>}
        {tab==="chat"&&<ChatModule user={user}/>}
        {tab==="ai"&&<AIModule user={user}/>}
        {tab==="settings"&&<SettingsModule user={user} onLogout={logout}
          onInstall={showInstall?handleInstall:null}/>}
      </div>

      <div style={{position:"fixed",bottom:0,left:"50%",
        transform:"translateX(-50%)",width:"100%",maxWidth:"480px",
        background:C.white,borderTop:`1px solid ${C.border}`,
        display:"flex",zIndex:200,boxShadow:"0 -3px 16px rgba(0,0,0,0.1)"}}>
        {nav.map(n=>(
          <button key={n.id} onClick={()=>setTab(n.id)} style={{flex:1,
            padding:"10px 0 8px",background:"none",border:"none",cursor:"pointer",
            display:"flex",flexDirection:"column",alignItems:"center",gap:"2px",
            color:tab===n.id?C.forest:"#bbb",fontFamily:"inherit",
            fontSize:"0.58rem",fontWeight:700,transition:"color 0.15s",
            position:"relative"}}>
            <span style={{fontSize:"1.1rem",
              transform:tab===n.id?"scale(1.2)":"scale(1)",
              transition:"transform 0.15s",display:"block"}}>{n.icon}</span>
            {n.l}
            {tab===n.id&&<div style={{width:"4px",height:"4px",borderRadius:"50%",
              background:C.gold}}/>}
          </button>
        ))}
      </div>
    </div>
  );
}
