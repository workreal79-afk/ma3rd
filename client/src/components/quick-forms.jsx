import React,{useState} from "react";
import {api} from "../services/api.js";
import {Field} from "./ui.jsx";
import {errorMessage} from "../lib/errors.js";

export function QuickPersonForm({title,endpoint,onSaved}) {
  const [form,setForm]=useState({name:"",national_id:"",national_id_date:"",national_id_source:"",phone:"",city:"",address:""});
  const submit=async e=>{e.preventDefault();if(!form.name.trim())return alert(`اسم ${title} مطلوب`);try{const person=await api(endpoint,{method:"POST",body:JSON.stringify(form)});onSaved(person);}catch(err){alert(errorMessage(err))}};
  return <form onSubmit={submit}><div className="box" style={{marginBottom:12}}>يمكنك تسجيل {title} بسرعة أثناء المبايعة. الاسم فقط مطلوب، وباقي البيانات اختيارية.</div><Field label={`اسم ${title} *`} v={form.name} set={v=>setForm({...form,name:v})}/><div className="grid2"><Field label="رقم الهوية" v={form.national_id} set={v=>setForm({...form,national_id:v})}/><Field label="الجوال" v={form.phone} set={v=>setForm({...form,phone:v})}/><Field label="المدينة" v={form.city} set={v=>setForm({...form,city:v})}/><Field label="العنوان" v={form.address} set={v=>setForm({...form,address:v})}/></div><button className="primary full">حفظ {title} واختياره في المبايعة</button></form>;
}
export function QuickSellerForm({onSaved}) {
  const [form,setForm]=useState({name:"",national_id:"",phone:"",city:"",address:""});
  const submit=async e=>{
    e.preventDefault();
    if(!form.name.trim()) return alert("اسم البائع مطلوب");
    try {
      const seller=await api("/sellers",{method:"POST",body:JSON.stringify(form)});
      onSaved(seller);
    } catch(err) { alert(errorMessage(err)); }
  };
  return <form onSubmit={submit}>
    <div className="box" style={{marginBottom:12}}>يمكنك تسجيل البائع بسرعة أثناء المبايعة. الاسم فقط مطلوب، وباقي البيانات اختيارية ويمكن استكمالها لاحقًا من قسم البائعين.</div>
    <Field label="اسم البائع *" v={form.name} set={v=>setForm({...form,name:v})}/>
    <div className="grid2">
      <Field label="رقم الهوية" v={form.national_id} set={v=>setForm({...form,national_id:v})}/>
      <Field label="الجوال" v={form.phone} set={v=>setForm({...form,phone:v})}/>
      <Field label="المدينة" v={form.city} set={v=>setForm({...form,city:v})}/>
      <Field label="العنوان" v={form.address} set={v=>setForm({...form,address:v})}/>
    </div>
    <button className="primary full">حفظ البائع واختياره في المبايعة</button>
  </form>;
}
