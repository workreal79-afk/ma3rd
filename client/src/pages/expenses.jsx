import React,{useEffect,useState} from "react";
import {api,money,today} from "../services/api.js";
import {LoadError,Modal,Table,Toolbar,Field} from "../components/ui.jsx";
import {errorMessage} from "../lib/errors.js";

export function Expenses({refresh,setRefresh}){
 const blank=()=>({id:null,category:"تشغيلية",amount:"",expense_date:today(),description:""});
 const [rows,setRows]=useState([]),[open,setOpen]=useState(false),[form,setForm]=useState(blank()),[error,setError]=useState("");
 // كان الخطأ يُبتلع بـ .catch(()=>{}) فيرى المستخدم «لا توجد بيانات» بدل سبب العطل
 const load=()=>api('/expenses').then(r=>{setRows(r);setError("")}).catch(e=>setError(errorMessage(e))); useEffect(()=>{load()},[refresh]);
 const save=async e=>{e.preventDefault();try{const path=form.id?`/expenses/${form.id}`:'/expenses';const method=form.id?'PUT':'POST';await api(path,{method,body:JSON.stringify(form)});setOpen(false);setForm(blank());setRefresh(x=>x+1)}catch(err){alert(errorMessage(err))}};
 const remove=async x=>{const reason=window.prompt(`سبب إلغاء المصروف ${x.category} بمبلغ ${money(x.amount)} ريال:`);if(!reason?.trim())return;if(!window.confirm("سيتم وضع المصروف كملغى مع الاحتفاظ به في السجل؛ لن يتم حذفه نهائيًا."))return;try{await api(`/expenses/${x.id}`,{method:'DELETE',body:JSON.stringify({reason})});setRefresh(v=>v+1)}catch(err){alert(errorMessage(err))}};
 return <div><Toolbar title="المصروفات" button="إضافة مصروف" onClick={()=>{setForm(blank());setOpen(true)}}/>{error?<LoadError error={error} onRetry={load}/>:<section className="panel"><Table headers={["التاريخ","البند","المبلغ","البيان","الحالة","إجراء"]} rows={rows.map(x=>[x.expense_date,x.category,`${money(x.amount)} ريال`,x.description||'-',x.status==="VOIDED"?<span className="badge red">ملغى</span>:<span className="badge green">فعال</span>,<div className="actions">{x.status!=="VOIDED"&&<><button className="smallBtn" onClick={()=>{setForm({...x});setOpen(true)}}>تعديل</button><button className="smallBtn" onClick={()=>remove(x)}>إلغاء مع سبب</button></>}</div>])}/></section>}{open&&<Modal title={form.id?"تعديل المصروف":"إضافة مصروف"} onClose={()=>setOpen(false)}><form onSubmit={save}><div className="grid2"><Field label="البند" v={form.category} set={v=>setForm({...form,category:v})}/><Field label="المبلغ" type="number" v={form.amount} set={v=>setForm({...form,amount:v})}/><Field label="التاريخ" type="date" v={form.expense_date} set={v=>setForm({...form,expense_date:v})}/></div><Field label="البيان" v={form.description} set={v=>setForm({...form,description:v})}/><button className="primary full">{form.id?"حفظ التعديل":"حفظ المصروف"}</button></form></Modal>}</div>
}

