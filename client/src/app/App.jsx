import React,{useEffect,useRef,useState} from "react";
import {API,api} from "../services/api.js";
import {NAV_ITEMS,NAV_GROUPS} from "./navigation.js";
import {useRefreshKey} from "./hooks/useRefreshKey.js";
import {errorMessage} from "../lib/errors.js";
import {Modal} from "../components/ui.jsx";
import {GlobalSearch} from "../components/global-search.jsx";
import {Dashboard} from "../pages/dashboard.jsx";
import {Vehicles} from "../pages/vehicles.jsx";
import {Customers,Sellers,Guarantors} from "../pages/people.jsx";
import {Sales} from "../pages/sales.jsx";
import {Collections} from "../pages/collections.jsx";
import {Expenses} from "../pages/expenses.jsx";
import {Reports} from "../pages/reports.jsx";
import {AuditLog} from "../pages/audit.jsx";
import {Messaging} from "../pages/messaging.jsx";
import {StaffUsers} from "../pages/staff-users.jsx";

export function App(){
  const [page,setPage]=useState("dashboard");
  const [demo,setDemo]=useState(false);
  const [auth,setAuth]=useState({loading:true,authenticated:false,username:null});
  const [login,setLogin]=useState({username:"",password:"",error:"",busy:false});
  const [showPassword,setShowPassword]=useState(false);
  useEffect(()=>{
    api("/auth/session").then(info=>setAuth({loading:false,...info})).catch(()=>setAuth({loading:false,authenticated:false,username:null}));
    api("/health").then(info=>setDemo(Boolean(info.demo))).catch(()=>{});
  },[]);
  const doLogin=async e=>{
    e.preventDefault(); setLogin(x=>({...x,error:"",busy:true}));
    try {
      const info=await api("/auth/login",{method:"POST",body:JSON.stringify({username:login.username,password:login.password})});
      setAuth({loading:false,...info}); setLogin({username:"",password:"",error:"",busy:false});
    } catch(err) { setLogin(x=>({...x,busy:false,error:err.message||"تعذر تسجيل الدخول"})); }
  };
  const logout=async()=>{try{await api("/auth/logout",{method:"POST"});}finally{setAuth({loading:false,authenticated:false,username:null});}};
  const [refresh,setRefresh]=useRefreshKey();
  // البحث الموحد يمرّر كلمته للصفحة المقصودة، وnavToken يعيد تهيئة الصفحة عند كل انتقال.
  const [searchQuery,setSearchQuery]=useState(""),[navToken,setNavToken]=useState(0);
  const [restoreOpen,setRestoreOpen]=useState(false),[restoring,setRestoring]=useState(false),[backupStatus,setBackupStatus]=useState(null);
  const [sidebarOpen,setSidebarOpen]=useState(true);
  const fileRef=useRef(null);
  useEffect(()=>{if(auth.role==="ADMIN"||auth.role==="ACCOUNTANT")api("/backup/status").then(setBackupStatus).catch(()=>{});},[refresh,auth.role]);
  if(auth.loading) return <div className="loginPage" dir="rtl"><div className="loginCard loginLoading"><div className="loginBrandMark" aria-hidden="true">🚘</div><div className="brand loginBrand">معرض الزبيدي<small>جاري التحقق من الجلسة...</small></div><div className="loadingTrack" role="status" aria-label="جاري التحقق من الجلسة"><span/></div></div></div>;
  if(!auth.authenticated) return <div className="loginPage" dir="rtl"><form className="loginCard" onSubmit={doLogin} aria-label="تسجيل الدخول"><div className="loginBrandMark" aria-hidden="true">🚘</div><div className="brand loginBrand">معرض الزبيدي<small>إدارة معرضك، بوضوح وبسهولة</small></div><div className="loginIntro"><h1>مرحباً بعودتك</h1><p>سجّل الدخول للمتابعة إلى لوحة المعرض.</p></div><label className="field"><span>اسم المستخدم</span><input autoFocus value={login.username} onChange={e=>setLogin(x=>({...x,username:e.target.value}))} autoComplete="username" required /></label><div className="field"><label className="fieldLabel" htmlFor="login-password">كلمة المرور</label><div className="passwordField"><input id="login-password" type={showPassword?"text":"password"} value={login.password} onChange={e=>setLogin(x=>({...x,password:e.target.value}))} autoComplete="current-password" required /><button className="passwordToggle" type="button" aria-label={showPassword?"إخفاء كلمة المرور":"إظهار كلمة المرور"} aria-pressed={showPassword} onClick={()=>setShowPassword(value=>!value)}>{showPassword?"إخفاء":"إظهار"}</button></div></div>{login.error&&<div className="loginError" role="alert">{login.error}</div>}<button className="primary full" disabled={login.busy} aria-busy={login.busy}>{login.busy?"جاري تسجيل الدخول...":"تسجيل الدخول"}</button><details className="loginHelp"><summary>هل هذه أول مرة تستخدم النظام؟</summary><p>استخدم بيانات المدير التي تظهر في نافذة تشغيل الخادم أو ملف FIRST-RUN-ADMIN.txt داخل مجلد البيانات، ثم غيّر كلمة المرور.</p></details></form></div>;
  const canSeeBackup=auth.role==="ADMIN"||auth.role==="ACCOUNTANT";
  const nav=NAV_ITEMS.filter(([id]) => id === "users" ? auth.role === "ADMIN" : id === "audit" ? canSeeBackup : true);
  const navGroups=NAV_GROUPS.map(group=>({...group,items:nav.filter(([id])=>group.ids.includes(id))})).filter(group=>group.items.length);
  const navigate=(next,payload={})=>{setPage(next);setSearchQuery(payload.query||"");setNavToken(t=>t+1);setSidebarOpen(false)};
  const backup=()=>window.open(`${API}/backup`,`_blank`);
  const restore=async e=>{const file=e.target.files?.[0]; if(!file)return; if(!window.confirm("سيتم استبدال البيانات الحالية بالنسخة الاحتياطية. هل أنت متأكد؟")){e.target.value="";return} setRestoring(true); try{const r=await fetch(`${API}/restore`,{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:file}); const data=await r.json().catch(()=>({})); if(!r.ok)throw new Error(data.error||"فشل الاسترجاع"); alert("تم استرجاع النسخة الاحتياطية بنجاح"); setRefresh(x=>x+1); window.location.reload();}catch(err){alert(errorMessage(err))}finally{setRestoring(false);e.target.value=""}};
  return <div className={sidebarOpen?"app":"app sidebarCollapsed"}><a className="skipLink" href="#main-content">انتقل إلى المحتوى</a><aside aria-hidden={!sidebarOpen} inert={!sidebarOpen}><div className="brand">معرض الزبيدي<small>إدارة المعرض</small></div><nav id="main-navigation" className="navigation" aria-label="التنقل الرئيسي">{navGroups.map(group=><div className="navGroup" key={group.id}>{group.title&&<div className="navGroupTitle">{group.title}</div>}{group.items.map(([id,t,icon])=><button type="button" className={page===id?"nav active":"nav"} key={id} onClick={()=>navigate(id)} aria-current={page===id?"page":undefined}><span aria-hidden="true">{icon}</span>{t}</button>)}</div>)}</nav></aside><main id="main-content" tabIndex="-1"><header className="appHeader"><div className="pageHeading"><button type="button" className="sidebarToggle" onClick={()=>setSidebarOpen(value=>!value)} aria-label={sidebarOpen?"إخفاء القائمة الجانبية":"إظهار القائمة الجانبية"} aria-expanded={sidebarOpen} aria-controls="main-navigation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h16"/><path d="m16 9 3 3-3 3"/></svg></button><div className="pageHeadingText"><h1>{nav.find(x=>x[0]===page)?.[1]}</h1><p>نظام الإدارة الداخلي</p></div></div><GlobalSearch onNavigate={navigate}/><div className="headerActions">{canSeeBackup&&<button type="button" className="backupBtn" onClick={backup}>💾 نسخة احتياطية</button>}{backupStatus?.enabled&&<span className={`backupStatus${backupStatus.lastError?" backupStatusError":""}`} title={backupStatus.lastError?`تعذر إنشاء النسخة الاحتياطية (${backupStatus.lastError})`:"تُنشأ نسخة احتياطية تلقائيًا بعد كل إجراء ناجح"}>{backupStatus.lastError?"⚠️ تعذّر النسخ التلقائي":"🛡️ نسخ تلقائي بعد كل إجراء"}</span>}{auth.role==="ADMIN"&&<button type="button" className="backupBtn" onClick={()=>setRestoreOpen(true)}>♻️ استرجاع</button>}<div className="user">{auth.username||"المدير"}</div><button type="button" className="backupBtn" onClick={logout}>تسجيل الخروج</button></div></header><div className="content">{demo&&<div className="box" role="status" style={{background:"#fff7ed",borderColor:"#fed7aa",marginBottom:16}}>⚠️ نسخة تجريبية بقاعدة بيانات منفصلة — لا تدخل بيانات حقيقية أو بيانات دخول واتساب حقيقية هنا.</div>}
    {page==="dashboard"&&<Dashboard key={navToken} refresh={refresh} onNavigate={navigate}/>}
    {page==="vehicles"&&<Vehicles key={navToken} refresh={refresh} setRefresh={setRefresh} initialSearch={searchQuery}/>}
    {page==="customers"&&<Customers key={navToken} refresh={refresh} setRefresh={setRefresh} initialSearch={searchQuery}/>}
    {page==="sellers"&&<Sellers key={navToken} refresh={refresh} setRefresh={setRefresh} initialSearch={searchQuery}/>}
    {page==="parties"&&<Guarantors key={navToken} refresh={refresh} setRefresh={setRefresh} initialSearch={searchQuery}/>}
    {page==="sales"&&<Sales key={navToken} refresh={refresh} setRefresh={setRefresh} initialSearch={searchQuery}/>}
    {page==="collections"&&<Collections key={navToken} refresh={refresh}/>}
    {page==="expenses"&&<Expenses key={navToken} refresh={refresh} setRefresh={setRefresh}/>}
    {page==="reports"&&<Reports key={navToken} refresh={refresh}/>}
    {page==="audit"&&<AuditLog key={navToken} refresh={refresh}/>}
    {page==="messaging"&&<Messaging key={navToken} refresh={refresh}/>}
    {page==="users"&&auth.role==="ADMIN"&&<StaffUsers key={navToken} refresh={refresh}/>}
  </div></main>{restoreOpen&&<Modal title="استرجاع نسخة احتياطية" onClose={()=>setRestoreOpen(false)}><div className="box"><b>تنبيه:</b> الاسترجاع يستبدل بيانات النظام الحالية ببيانات النسخة المختارة. يفضل أخذ نسخة احتياطية حالية أولًا.</div><input ref={fileRef} type="file" accept=".sqlite,.db,application/octet-stream" onChange={restore} style={{display:"none"}}/><button className="primary full" disabled={restoring} onClick={()=>fileRef.current?.click()}>{restoring?"جاري الاسترجاع...":"اختيار ملف النسخة الاحتياطية"}</button></Modal>}</div>
}
