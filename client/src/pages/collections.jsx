import React,{useEffect,useState,useMemo} from "react";
import {API,api,money,today} from "../services/api.js";
import {LoadError,Modal,Table,Toolbar,Field,Select,Status} from "../components/ui.jsx";
import {errorMessage} from "../lib/errors.js";
import {WhatsAppButton} from "../components/whatsapp-button.jsx";

export function Collections({refresh}) {
  const [rows,setRows]=useState([]),[payments,setPayments]=useState([]),[selectedCustomer,setSelectedCustomer]=useState(null),[tab,setTab]=useState("customers"),[editPayment,setEditPayment]=useState(null),[error,setError]=useState("");
  const [unallocated,setUnallocated]=useState([]),[uCustomers,setUCustomers]=useState([]),[unallocatedOpen,setUnallocatedOpen]=useState(false),[unallocatedForm,setUnallocatedForm]=useState({customer_id:"",amount:"",payment_date:today(),payment_method:"CASH",notes:"",confirmed:false});
  // نافذة منبثقة عند كل فشل تحميل → رسالة خطأ داخل الصفحة مع زر إعادة المحاولة
  const load=()=>Promise.all([api("/installments"),api("/payments"),api("/unallocated-receipts"),api("/customers")]).then(([i,p,u,c])=>{setRows(Array.isArray(i)?i:[]);setPayments(Array.isArray(p)?p:[]);setUnallocated(Array.isArray(u)?u:[]);setUCustomers(Array.isArray(c)?c:[]);setError("")}).catch(e=>setError(errorMessage(e)));
  useEffect(()=>{load();},[refresh]);

  const customers=useMemo(()=>{
    const map=new Map();
    rows.forEach(i=>{
      const key=String(i.customer_id || i.customer_name || "");
      if(!map.has(key)) map.set(key,{id:i.customer_id,name:i.customer_name,contractCount:0,total:0,paid:0,remaining:0,nextDue:null,overdue:0,installments:[]});
      const c=map.get(key);
      c.installments.push(i); c.total+=Number(i.amount||0); c.paid+=Number(i.paid_amount||0); c.remaining+=Math.max(0,Number(i.amount||0)-Number(i.paid_amount||0));
      if(i.contract_number && !c.installments.slice(0,-1).some(x=>x.contract_number===i.contract_number)) c.contractCount++;
      if(i.paid_amount < i.amount){
        if(!c.nextDue || i.due_date < c.nextDue) c.nextDue=i.due_date;
        if(i.status === "OVERDUE") c.overdue += Math.max(0,Number(i.amount||0)-Number(i.paid_amount||0));
      }
    });
    return Array.from(map.values()).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ar'));
  },[rows]);

  const refreshData=()=>load();
  const pay=async (item,amount,method)=>{
    try{
      const r=await api(`/installments/${item.id}/payments`,{method:"POST",body:JSON.stringify({amount:Number(amount),payment_method:method,payment_date:today()})});
      setSelectedCustomer(null);
      await load();
      window.open(r.receipt_url,"_blank");
    }catch(e){alert(errorMessage(e))}
  };

  return <div>
    <Toolbar title="الأقساط والتحصيل"/>
    <div className="collectionTabs">
      <button className={tab==="customers"?"primary tabBtn":"tabBtn"} onClick={()=>setTab("customers")}>ملفات المشترين والأقساط</button>
      <button className={tab==="payments"?"primary tabBtn":"tabBtn"} onClick={()=>setTab("payments")}>سجل التحصيلات</button>
      <button className={tab==="unallocated"?"primary tabBtn":"tabBtn"} onClick={()=>setTab("unallocated")}>مبالغ غير موزعة</button>
    </div>

    {error&&<LoadError error={error} onRetry={load}/>}

    {tab==="customers"&&<>
      <div className="box collectionHint"><b>طريقة التحصيل:</b> اختر المشتري أولًا، ثم ستظهر لك عقوده وأقساطه. اضغط على القسط المطلوب لتحصيله وطباعة الإيصال مباشرة.</div>
      <section className="customerCollectionGrid">
        {customers.length?customers.map(c=><button type="button" className="customerCollectionCard" key={c.id||c.name} onClick={()=>setSelectedCustomer(c)}>
          <div className="customerCardTop"><div className="avatar">{String(c.name||"م").trim().slice(0,1)}</div><div><h3>{c.name}</h3><span>{c.contractCount} عقد • {c.installments.length} قسط</span></div></div>
          <div className="customerCardStats"><div><span>إجمالي</span><b>{money(c.total)} ريال</b></div><div><span>مدفوع</span><b>{money(c.paid)} ريال</b></div><div><span>متبقي</span><b>{money(c.remaining)} ريال</b></div></div>
          <div className="customerCardBottom">{c.nextDue?<>أقرب استحقاق: <b>{c.nextDue}</b></>:<b className="badge green">مكتمل</b>}{c.overdue>0&&<span className="badge red">متأخر {money(c.overdue)} ريال</span>}</div>
        </button>):<div className="empty">لا توجد أقساط مسجلة حتى الآن</div>}
      </section>
    </>}

    {tab==="payments"&&<section className="panel"><div className="panelTitle"><h3>سجل التحصيلات</h3><button className="smallBtn" onClick={refreshData}>تحديث</button></div><div className="box" style={{marginBottom:12}}>الإيصال المعكوس يظل محفوظًا في السجل. إلغاء القيد لا يعني رد الفلوس؛ سجّل الرد فقط إذا تم فعلًا.</div><Table headers={["الإيصال","التاريخ","العميل","العقد","القسط","المبلغ","صافي التحصيل","الحالة","إجراء"]} rows={payments.map(p=>[p.receipt_number,p.payment_date,p.customer_name,p.contract_number,p.installment_number,`${money(p.amount)} ريال`,`${money(p.net_amount??(Number(p.amount)-Number(p.refund_total||0)))} ريال`,p.status==="REVERSED"?<span className="badge red">معكوس</span>:Number(p.refund_total||0)>0?<span className="badge orange">رد جزئي</span>:<span className="badge green">فعال</span>,<div className="actions"><WhatsAppButton kind="PAYMENT_RECEIPT" receiptNumber={p.receipt_number} label="إيصال"/>{p.status==="ACTIVE"&&<><button className="smallBtn" onClick={()=>setEditPayment(p)}>تعديل</button><button className="smallBtn" onClick={async()=>{const reason=window.prompt(`سبب عكس التحصيل ${p.receipt_number}:`);if(!reason?.trim())return;try{await api(`/payments/${p.id}`,{method:"DELETE",body:JSON.stringify({reason})});await load()}catch(e){alert(errorMessage(e))}}}>عكس القيد</button><button className="smallBtn" onClick={async()=>{const choices=rows.filter(i=>Number(i.id)!==Number(p.installment_id)&&Number(i.customer_id)===Number(p.customer_id)&&i.status!=="CANCELLED"&&Number(i.amount)>Number(i.paid_amount));if(!choices.length)return alert("لا توجد أقساط أخرى مفتوحة لهذا المشتري.");const list=choices.map(i=>`${i.id}: ${i.contract_number} — قسط ${i.installment_number} — متبقي ${money(Number(i.amount)-Number(i.paid_amount))} ريال`).join("\n");const target=window.prompt(`اكتب رقم القسط الداخلي المطلوب نقل التحصيل إليه:\n${list}`);if(!target)return;const reason=window.prompt("سبب نقل التحصيل:");if(!reason?.trim())return;try{const r=await api(`/payments/${p.id}/transfer`,{method:"POST",body:JSON.stringify({target_installment_id:Number(target),reason})});await load();alert(`تم النقل إلى الإيصال ${r.receipt_number}`)}catch(e){alert(errorMessage(e))}}}>نقل لقسط</button><button className="smallBtn" onClick={async()=>{const amount=window.prompt(`مبلغ تم رده فعليًا من إيصال ${p.receipt_number} (المتبقي غير المردود ${money(Number(p.amount)-Number(p.refund_total||0))} ريال):`);if(amount===null||!String(amount).trim())return;const reason=window.prompt("سبب الرد الفعلي:");if(!reason?.trim())return;if(!window.confirm("تأكيد مهم: هل تم رد هذا المبلغ فعلًا للعميل؟\nلن يتم إنشاء قيد رد بدون هذا التأكيد."))return;try{const r=await api(`/payments/${p.id}/refunds`,{method:"POST",body:JSON.stringify({amount:Number(amount),reason,refund_date:today(),confirmed:true})});await load();alert(r.message)}catch(e){alert(errorMessage(e))}}}>تسجيل رد فعلي</button></>}</div>])}/></section>}

    {tab==="unallocated"&&<section className="panel"><div className="panelTitle"><div><h3>الإيصالات ذات الرصيد غير الموزع</h3><span className="muted">تُسجّل هنا المبالغ التي استُلمت فعلًا ولم تُوجّه لقسط بعد.</span></div><button className="primary" onClick={()=>{setUnallocatedForm({customer_id:"",amount:"",payment_date:today(),payment_method:"CASH",notes:"",confirmed:false});setUnallocatedOpen(true)}}>تسجيل مبلغ مستلم</button></div><Table headers={["الإيصال","التاريخ","المشتري","المبلغ","الموزع","المتبقي","الحالة","إجراء"]} rows={unallocated.map(u=>[u.receipt_number,u.payment_date,u.customer_name,`${money(u.amount)} ريال`,`${money(u.allocated_amount)} ريال`,`${money(u.remaining_amount)} ريال`,u.status,<div className="actions">{Number(u.remaining_amount)>0&&u.status!=="CANCELLED"&&<button className="smallBtn" onClick={async()=>{const choices=rows.filter(i=>Number(i.customer_id)===Number(u.customer_id)&&i.status!=="CANCELLED"&&Number(i.amount)>Number(i.paid_amount));if(!choices.length)return alert("لا توجد أقساط مفتوحة لهذا المشتري.");const list=choices.map(i=>`${i.id}: ${i.contract_number} — قسط ${i.installment_number} — متبقي ${money(Number(i.amount)-Number(i.paid_amount))} ريال`).join("\n");const target=window.prompt(`اختر رقم القسط الداخلي لتوزيع المبلغ عليه:\n${list}`);if(!target)return;const amount=window.prompt(`المبلغ المراد توزيعه (المتبقي بالإيصال ${money(u.remaining_amount)} ريال):`,String(u.remaining_amount));if(amount===null||!amount.trim())return;const reason=window.prompt("سبب/بيان التوزيع:");if(!reason?.trim())return;try{await api(`/unallocated-receipts/${u.id}/allocate`,{method:"POST",body:JSON.stringify({installment_id:Number(target),amount:Number(amount),reason})});await load();alert("تم توزيع المبلغ وتسجيل إيصال تحصيل للقسط.")}catch(e){alert(errorMessage(e))}}}>توزيع على قسط</button>}{Number(u.allocated_amount||0)===0&&u.status!=="CANCELLED"&&<><button className="smallBtn" onClick={async()=>{const list=uCustomers.map(c=>`${c.id}: ${c.name}`).join("\n");const customerId=window.prompt(`تصحيح المشتري للإيصال ${u.receipt_number}. اختر رقم المشتري:\n${list}`,String(u.customer_id));if(customerId===null)return;if(!uCustomers.some(c=>Number(c.id)===Number(customerId)))return alert("رقم المشتري غير صحيح");const reason=window.prompt("سبب تصحيح المشتري:");if(!reason?.trim())return;try{await api(`/unallocated-receipts/${u.id}/customer`,{method:"PUT",body:JSON.stringify({customer_id:Number(customerId),reason})});await load();alert("تم تصحيح الإسناد دون إنشاء تحصيل جديد.")}catch(e){alert(errorMessage(e))}}}>تصحيح المشتري</button><button className="smallBtn danger" onClick={async()=>{const reason=window.prompt("سبب إلغاء تسجيل المبلغ:");if(!reason?.trim())return;if(!window.confirm("استخدم هذا الإجراء فقط لو هذا التسجيل لا يقابله مبلغ مستقل تم استلامه فعليًا. لن يُسجل أي رد أموال. هل تؤكد أن المبلغ لم يُستلم فعليًا؟"))return;try{await api(`/unallocated-receipts/${u.id}/cancel`,{method:"POST",body:JSON.stringify({reason,confirmed_not_received:true})});await load();alert("تم إلغاء التسجيل فقط؛ لم يُسجل رد مالي.")}catch(e){alert(errorMessage(e))}}}>إلغاء تسجيل غير مستلم</button></>}</div>])}/></section>}
    {unallocatedOpen&&<Modal title="تسجيل مبلغ مستلم غير موزع" onClose={()=>setUnallocatedOpen(false)}><form onSubmit={async e=>{e.preventDefault();if(!unallocatedForm.confirmed)return alert("أكد استلام المبلغ فعلًا");try{const r=await api("/unallocated-receipts",{method:"POST",body:JSON.stringify({...unallocatedForm,customer_id:Number(unallocatedForm.customer_id),amount:Number(unallocatedForm.amount),confirmed:true})});setUnallocatedOpen(false);await load();alert(`تم تسجيل الإيصال ${r.receipt_number} كرصيد غير موزع.`)}catch(e){alert(errorMessage(e))}}}><div className="box">لا تستخدم هذه الشاشة لو المبلغ لم يدخل فعليًا. قيمة العربون المتفق عليه ليست تحصيلًا ماليًا دون استلام حقيقي.</div><Select label="المشتري" value={unallocatedForm.customer_id} onChange={v=>setUnallocatedForm(f=>({...f,customer_id:v}))} options={uCustomers.map(c=>[c.id,c.name])}/><div className="grid2"><Field label="المبلغ المستلم" type="number" v={unallocatedForm.amount} set={v=>setUnallocatedForm(f=>({...f,amount:v}))}/><Field label="تاريخ الاستلام" type="date" v={unallocatedForm.payment_date} set={v=>setUnallocatedForm(f=>({...f,payment_date:v}))}/><Select label="طريقة الدفع" value={unallocatedForm.payment_method} onChange={v=>setUnallocatedForm(f=>({...f,payment_method:v}))} options={[["CASH","نقدي"],["BANK_TRANSFER","تحويل بنكي"],["POS","شبكة"],["CHEQUE","شيك"]]}/></div><Field label="البيان" v={unallocatedForm.notes} set={v=>setUnallocatedForm(f=>({...f,notes:v}))}/><label className="checkRow"><input type="checkbox" checked={unallocatedForm.confirmed} onChange={e=>setUnallocatedForm(f=>({...f,confirmed:e.target.checked}))}/><span>أؤكد أن المبلغ تم استلامه فعليًا من المشتري</span></label><button className="primary full" disabled={!unallocatedForm.confirmed||!unallocatedForm.customer_id||Number(unallocatedForm.amount)<=0}>تسجيل الإيصال</button></form></Modal>}

        {editPayment&&<PaymentEditModal payment={editPayment} onClose={()=>setEditPayment(null)} onSaved={async()=>{setEditPayment(null);await load()}}/>}

    {selectedCustomer&&<CustomerCollectionProfile customer={selectedCustomer} onClose={()=>setSelectedCustomer(null)} onPay={pay}/>} 
  </div>
}

export function CustomerCollectionProfile({customer,onClose,onPay}){
  const [selected,setSelected]=useState(null);
  const [expanded,setExpanded]=useState(()=>new Set());
  const installments=[...(customer.installments||[])].sort((a,b)=>a.due_date.localeCompare(b.due_date)||Number(a.installment_number)-Number(b.installment_number));
  const contracts=[...new Set(installments.map(x=>x.contract_number))];
  const openPay=item=>{if(Number(item.amount)-Number(item.paid_amount)>0)setSelected(item)};
  // أنسب رسالة واتساب لعقد: أول قسط غير مسدَّد — لو متأخر نرسل تذكير تأخير، وإلا فاتورة تحصيل.
  const contractTarget=list=>{
    const open=[...list].filter(x=>Number(x.amount)-Number(x.paid_amount)>0)
      .sort((a,b)=>a.due_date.localeCompare(b.due_date)||Number(a.installment_number)-Number(b.installment_number));
    if(!open.length) return null;
    const item=open[0];
    return item.status==="OVERDUE" ? {item,kind:"OVERDUE_REMINDER",label:"تذكير تأخير"}
                                   : {item,kind:"COLLECTION_INVOICE",label:"فاتورة تحصيل"};
  };
  const toggleContract=contract=>setExpanded(prev=>{const next=new Set(prev); next.has(contract)?next.delete(contract):next.add(contract); return next;});
  const expandAll=()=>setExpanded(new Set(contracts));
  const collapseAll=()=>setExpanded(new Set());
  return <Modal title={`ملف المشتري — ${customer.name}`} onClose={onClose}>
    <div className="profileSummary">
      <div><span>العقود</span><b>{contracts.length}</b></div><div><span>إجمالي الأقساط</span><b>{money(customer.total)} ريال</b></div><div><span>المدفوع</span><b>{money(customer.paid)} ريال</b></div><div><span>المتبقي</span><b>{money(customer.remaining)} ريال</b></div>
    </div>
    <div className="profileActions"><button className="smallBtn" onClick={()=>window.open(`${API}/documents/customer-statement/${customer.id}`,'_blank')}>طباعة كشف الحساب</button><button className="smallBtn" onClick={expandAll}>فتح كل العقود</button><button className="smallBtn" onClick={collapseAll}>طي كل العقود</button></div>
    <div className="installmentProfileList">
      {contracts.map(contract=>{
        const list=installments.filter(x=>x.contract_number===contract);
        const first=list[0];
        return <section className="panel contractBlock" key={contract}>
          <div className="panelTitle"><div><h3>{contract}</h3><span className="muted">{first?.make||""} {first?.model||""} {first?.plate_number?`— ${first.plate_number}`:""}</span></div><div className="actions"><span className="badge blue">{list.length} قسط</span>{contractTarget(list)&&<WhatsAppButton kind={contractTarget(list).kind} installmentId={contractTarget(list).item.id} label={contractTarget(list).label}/>}<button type="button" className="smallBtn" onClick={()=>toggleContract(contract)}>{expanded.has(contract)?"طي":"فتح"}</button></div></div>
          {expanded.has(contract)&&<div className="miniInstallments">
            {list.map(i=>{
              const left=Math.max(0,Number(i.amount)-Number(i.paid_amount));
              return <button type="button" className={`miniInstallment ${i.status.toLowerCase()}`} key={i.id} onClick={()=>openPay(i)} disabled={left<=0}>
                <div><span>القسط {i.installment_number}</span><b>{money(i.amount)} ريال</b></div>
                <div><span>الاستحقاق</span><b>{i.due_date}</b></div>
                <div><span>المتبقي</span><b>{money(left)} ريال</b></div>
                <Status s={i.status}/>
                {left>0?<strong className="payAction">تحصيل ←</strong>:<span className="paidText">تم السداد</span>}
              </button>
            })}
          </div>}
        </section>
      })}
    </div>
    {selected&&<PaymentModal item={selected} onClose={()=>setSelected(null)} onPay={(amount,method)=>onPay(selected,amount,method)}/>} 
  </Modal>
}

export function PaymentEditModal({payment,onClose,onSaved}) {
  const [amount,setAmount]=useState(String(payment.amount)),[date,setDate]=useState(payment.payment_date),[method,setMethod]=useState(payment.payment_method);
  const save=async()=>{try{await api(`/payments/${payment.id}`,{method:"PUT",body:JSON.stringify({amount:Number(amount),payment_date:date,payment_method:method})});await onSaved()}catch(e){alert(errorMessage(e))}};
  return <Modal title={`تعديل التحصيل ${payment.receipt_number}`} onClose={onClose}><div className="box" style={{marginBottom:12}}><b>{payment.customer_name}</b><br/>العقد: {payment.contract_number} — القسط: {payment.installment_number}<br/><span className="muted">يمكن تعديل قيمة التحصيل بشرط ألا تتجاوز إجمالي قيمة القسط.</span></div><Field label="المبلغ" type="number" v={amount} set={setAmount}/><Field label="تاريخ التحصيل" type="date" v={date} set={setDate}/><Select label="طريقة الدفع" value={method} onChange={setMethod} options={[["CASH","كاش"],["BANK_TRANSFER","تحويل بنكي"],["POS","شبكة / POS"]]}/><button className="primary full" onClick={save}>حفظ التعديل</button></Modal>
}

export function PaymentModal({item,onClose,onPay}) {
  const [amount,setAmount]=useState((item.amount-item.paid_amount).toFixed(2)),[method,setMethod]=useState("CASH");
  return <Modal title={`تحصيل القسط ${item.installment_number}`} onClose={onClose}><div className="box"><b>{item.customer_name}</b><br/>العقد: {item.contract_number}<br/>الاستحقاق: {item.due_date}<br/>المتبقي: {money(item.amount-item.paid_amount)} ريال</div><Field label="المبلغ" type="number" v={amount} set={setAmount}/><Select label="طريقة الدفع" value={method} onChange={setMethod} options={[["CASH","كاش"],["BANK_TRANSFER","تحويل بنكي"],["POS","شبكة / POS"]]}/><button className="primary full" onClick={()=>onPay(amount,method)}>تأكيد التحصيل وطباعة الإيصال</button></Modal>
}

