import React,{useEffect,useState} from "react";
import {api} from "../services/api.js";
import {LoadError,Table} from "../components/ui.jsx";

export function AuditLog({refresh}){
  const [rows,setRows]=useState([]),[error,setError]=useState("");
  const load=()=>api("/audit-log?limit=300").then(setRows).catch(e=>setError(e.message));
  useEffect(()=>{load()},[refresh]);
  const actionText={CREATE:"إنشاء",UPDATE:"تعديل",DELETE:"إلغاء/حذف",CANCEL:"إلغاء",RESTORE:"استرجاع",ARCHIVE:"أرشفة",MERGE:"دمج ملف",REVERSE:"عكس حركة",TRANSFER:"نقل تحصيل",REFUND:"رد مالي فعلي",VOID:"إلغاء مستند",REPLACE:"استبدال سند",REOPEN:"استعادة بيع",CORRECT:"تصحيح بيع",CORRECT_CUSTOMER:"تصحيح مشتري الإيصال",CANCEL_NOT_RECEIVED:"إلغاء تسجيل غير مستلم",CANCEL_CHANGE:"إيقاف إشعار بسبب تعديل",REPLACE_VEHICLE:"استبدال سيارة",RESERVE:"حجز سيارة",RELEASE_RESERVATION:"إلغاء حجز",CLOSE:"إغلاق عقد",RESCHEDULE:"إعادة جدولة",EARLY_SETTLEMENT:"سداد مبكر",CLOSE_CONTRACT:"إغلاق عقد",DISABLE:"تعطيل مستخدم",RESET_PASSWORD:"إعادة تعيين كلمة مرور",CREATE_USER:"إنشاء مستخدم",BACKUP:"نسخة احتياطية"};
  const typeText={SALE:"بيع",PAYMENT:"تحصيل",SELLER_PAYMENT:"سداد بائع",EXPENSE:"مصروف",VEHICLE:"سيارة",CUSTOMER:"مشتري",GUARANTOR:"كفيل",SELLER:"بائع",PROMISSORY_NOTE:"سند أمر",BROKER_COMMISSION:"عمولة قديمة (أرشيف)",SALE_BROKER:"بيانات وسيط قديمة (أرشيف)",UNALLOCATED_RECEIPT:"إيصال غير موزع",STAFF_USER:"مستخدم",CONTRACT:"عقد",DATABASE:"قاعدة البيانات"};
  return <div><div className="toolbar"><h2>سجل الحركات</h2><button className="smallBtn" onClick={load}>تحديث</button></div>{error?<LoadError error={error} onRetry={load}/>:<section className="panel"><div className="panelTitle"><h3>آخر الحركات</h3><span className="muted">يتم الاحتفاظ بالسجل للمراجعة ولا يؤثر حذفه على البيانات التشغيلية.</span></div><Table headers={["التاريخ والوقت","المستخدم","العملية","النوع","رقم السجل","التفاصيل"]} rows={rows.map(x=>[new Date(x.created_at.replace(" ","T")+"Z").toLocaleString("ar-SA"),x.actor||"system",actionText[x.action]||x.action,typeText[x.entity_type]||x.entity_type,x.entity_id||"-",x.details||"-"])}/></section>}</div>;
}

