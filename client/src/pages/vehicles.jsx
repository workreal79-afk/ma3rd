import React,{useEffect,useRef,useState} from "react";
import {api,money} from "../services/api.js";
import {errorMessage} from "../lib/errors.js";
import {LoadError,Modal,RecordCards,VehicleStatus,Field,Select} from "../components/ui.jsx";

export function Vehicles({refresh,setRefresh,initialSearch=""}) {
  const [rows,setRows]=useState([]), [sellers,setSellers]=useState([]), [open,setOpen]=useState(false), [edit,setEdit]=useState(null), [search,setSearch]=useState(initialSearch||""), [error,setError]=useState(""), [showArchived,setShowArchived]=useState(false);
  const empty=()=>({plate_number:"",vin:"",make:"",model:"",model_year:"",color:"",condition:"USED",images:[],price:"",ownership_type:"SHOWROOM",owner_seller_id:"",owner_seller:{name:"",national_id:"",national_id_date:"",national_id_source:"",phone:"",address:"",city:""}});
  const [form,setForm]=useState(empty());
  const load=()=>Promise.all([api(`/vehicles?search=${encodeURIComponent(search)}&includeArchived=${showArchived?1:0}`),api("/sellers")]).then(([v,se])=>{setRows(v);setSellers(se);setError("")}).catch(e=>setError(errorMessage(e)));
  useEffect(()=>{const t=setTimeout(load,250);return()=>clearTimeout(t)},[refresh,search,showArchived]);
  const archiveVehicle=async v=>{const reason=window.prompt(`سبب أرشفة السيارة ${v.make} ${v.model} — ${v.plate_number}:`);if(!reason?.trim())return;try{await api(`/vehicles/${v.id}`,{method:"DELETE",body:JSON.stringify({reason})});await load()}catch(e){alert(errorMessage(e))}};
  const restoreVehicle=async v=>{if(!window.confirm(`استعادة السيارة ${v.plate_number}؟`))return;try{await api(`/vehicles/${v.id}/restore`,{method:"POST",body:JSON.stringify({})});await load()}catch(e){alert(errorMessage(e))}};
  const permanentlyDeleteVehicle=async v=>{if(!window.confirm(`تحذير: حذف نهائي للسيارة ${v.make} ${v.model} — ${v.plate_number}.\nسيتم حذف المبايعات الملغاة التابعة وكل العقود والتحصيلات والكمبيالات والسندات والمصروفات والحجوزات المرتبطة بها. يجب إلغاء المبايعات النشطة أولًا.\n\nلا يمكن التراجع عن هذا الإجراء. متابعة؟`))return;const confirmText=window.prompt('اكتب «حذف نهائي» للتأكيد:');if(confirmText!=="حذف نهائي")return;try{await api(`/vehicles/${v.id}/permanent`,{method:"DELETE",body:JSON.stringify({confirmation:"حذف نهائي"})});await load();alert("تم الحذف النهائي وحذف المبايعات الملغاة والمصروفات والحجوزات التابعة")}catch(e){alert(errorMessage(e))}};
  const duplicateToStock=async v=>{if(v.status!=="SOLD")return;const ok=window.confirm(`إنشاء سيارة جديدة في المخزون بنفس بيانات ${v.make} ${v.model} — اللوحة ${v.plate_number}؟\n\nسيبقى سجل السيارة المباعة ومبايعتها القديمة كما هما، وستُنشأ وحدة مخزون مستقلة يمكنك بيعها لمشترٍ جديد.`);if(!ok)return;try{const full=await api(`/vehicles/${v.id}`);const images=JSON.parse(full.images_json||"[]");const created=await api("/vehicles",{method:"POST",body:JSON.stringify({plate_number:full.plate_number,vin:full.vin,make:full.make,model:full.model,model_year:full.model_year,color:full.color,condition:full.condition||"USED",images,price:full.price||0,ownership_type:full.ownership_type||"SHOWROOM",owner_seller_id:full.owner_seller_id||null,notes:`نسخة مخزون جديدة من السيارة المباعة رقم ${full.id}`})});await load();alert(`تمت إضافة نسخة جديدة للمخزون برقم سجل ${created.id}. يمكنك الآن بيعها كعملية مستقلة.`)}catch(e){alert(errorMessage(e))}};
  const toggleReservation=async v=>{try{if(v.status==="RESERVED"){const list=await api("/reservations?all=1");const active=(Array.isArray(list)?list:[]).find(r=>Number(r.vehicle_id)===Number(v.id)&&r.status==="ACTIVE");if(!active)throw new Error("لا يوجد سجل حجز نشط لهذه السيارة؛ راجع سجل الحجوزات قبل تغيير حالتها.");const reason=window.prompt("سبب إلغاء الحجز:");if(!reason?.trim())return;await api(`/reservations/${active.id}/release`,{method:"POST",body:JSON.stringify({reason})});}else{const customerText=window.prompt("رقم المشتري المسجل (اختياري، اتركه فارغًا إن لم يكن مسجلًا):","");if(customerText===null)return;const expiry=window.prompt("تاريخ انتهاء الحجز YYYY-MM-DD (اختياري):","");if(expiry===null)return;const depositText=window.prompt("العربون المتفق عليه فقط (لا يسجل تحصيلًا ماليًا):","0");if(depositText===null)return;const reason=window.prompt("ملاحظات الحجز:","");if(reason===null)return;await api(`/vehicles/${v.id}/reservations`,{method:"POST",body:JSON.stringify({customer_id:customerText.trim()?Number(customerText):null,expires_at:expiry.trim()||null,deposit_amount:Number(depositText||0),reason})});}await load()}catch(e){alert(errorMessage(e))}};
  const updateOwner=(field,value)=>setForm(f=>({...f,owner_seller:{...f.owner_seller,[field]:value}}));
  const readImages=async files=>{const arr=[];for(const file of Array.from(files)){if(!file.type?.startsWith("image/")){alert("يمكن إضافة ملفات الصور فقط");continue}if(file.size>1200000){alert("حجم الصورة يجب ألا يتجاوز 1.2MB");continue}arr.push(await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)}))}return arr};
  const addImages=async files=>{const selected=Array.from(files),remaining=Math.max(0,5-(form.images||[]).length);if(selected.length>remaining)alert(`يمكن إضافة ${remaining} صور إضافية فقط`);const imgs=await readImages(selected.slice(0,remaining));setForm(f=>({...f,images:[...(f.images||[]),...imgs].slice(0,5)}));};
  const addEditImages=async files=>{const selected=Array.from(files),remaining=Math.max(0,5-(edit.images||[]).length);if(selected.length>remaining)alert(`يمكن إضافة ${remaining} صور إضافية فقط`);const imgs=await readImages(selected.slice(0,remaining));setEdit(current=>({...current,images:[...(current.images||[]),...imgs].slice(0,5)}));};
  const submit=async e=>{e.preventDefault();if(form.ownership_type==="THIRD_PARTY"&&!form.owner_seller_id&&!form.owner_seller.name.trim())return alert("أدخل بيانات البائع لأن السيارة مملوكة للغير");try{await api("/vehicles",{method:"POST",body:JSON.stringify(form)});setOpen(false);setForm(empty());setRefresh(x=>x+1)}catch(err){alert(errorMessage(err))}};
  // قائمة السيارات لم تعد تحمل images_json (كانت 152 ميجابايت مع 20 سيارة مصوّرة)،
  // لذلك تُجلب الصور من GET /api/vehicles/:id عند فتح نافذة التعديل فقط.
  const openEdit=async v=>{try{const full=await api(`/vehicles/${v.id}`);setEdit({...full,images:JSON.parse(full.images_json||"[]")})}catch(err){alert(errorMessage(err))}};
  const saveEdit=async e=>{e.preventDefault();try{await api(`/vehicles/${edit.id}`,{method:"PUT",body:JSON.stringify(edit)});setEdit(null);setRefresh(x=>x+1)}catch(err){alert(errorMessage(err))}};
  return <div><div className="toolbar"><h2>السيارات</h2><div className="actions"><button className="smallBtn" onClick={()=>setShowArchived(v=>!v)}>{showArchived?"المتاحة فقط":"عرض المؤرشف أيضًا"}</button><button className="primary" onClick={()=>setOpen(true)}>إضافة سيارة</button></div></div><div className="searchBar"><input aria-label="بحث في السيارات" placeholder="بحث باللوحة أو الهيكل أو الماركة أو الموديل أو اسم البائع" value={search} onChange={e=>setSearch(e.target.value)}/></div>
    {error?<LoadError error={error} onRetry={load}/>:<RecordCards title="سجل السيارات" description="حالة كل سيارة وملكيتها وسعرها في بطاقة واضحة" emptyMessage="لا توجد بيانات سيارات مطابقة." rows={rows.map(v=>({key:v.id,
      details:<div className="recordDetails vehicleRecordDetails"><div className="recordCardTop"><span className="recordIcon vehicleRecordIcon" aria-hidden="true">🚘</span><div className="recordHeading"><span className="recordEyebrow">السيارة</span><h3>{v.make} {v.model}</h3><span className="recordPlate vehicleCardPlate">اللوحة: {v.plate_number||"-"}</span></div><div className="vehicleCardStatus"><VehicleStatus s={v.archived_at?"ARCHIVED":v.status}/></div></div>
        <div className="recordMetaGrid"><div><span>الحالة</span><strong>{v.condition==="NEW"?"جديد":"مستعمل"}</strong></div><div><span>الملكية</span><strong>{v.ownership_type==="THIRD_PARTY"?"بائع":"المعرض"}</strong></div><div><span>البائع</span><strong>{v.owner_seller_name||"-"}</strong></div>{v.sold_customer_name&&<div><span>المشتري</span><strong>{v.sold_customer_name}</strong></div>}{Number(v.image_count)>0&&<div><span>الصور</span><strong>{v.image_count} صور</strong></div>}</div>
      </div>,
      actions:<div className="recordCardSide"><div className="recordPrice"><span>سعر السيارة</span><strong>{money(v.price)} <small>ريال</small></strong></div><div className="recordActionGroup"><span className="recordActionLabel">إجراءات السيارة</span><div className="actions recordActions">{v.archived_at?<><button className="smallBtn" onClick={()=>restoreVehicle(v)}>استعادة</button><button className="smallBtn danger" onClick={()=>permanentlyDeleteVehicle(v)}>حذف نهائي</button></>:<><button className="smallBtn" onClick={()=>openEdit(v)}>تعديل</button>{v.status==="SOLD"&&<button className="smallBtn" onClick={()=>duplicateToStock(v)}>نسخة جديدة للمخزون</button>}{v.status!=="SOLD"&&<button className="smallBtn" onClick={()=>toggleReservation(v)}>{v.status==="RESERVED"?"إلغاء الحجز":"حجز"}</button>}<button className="smallBtn" onClick={()=>archiveVehicle(v)}>أرشفة</button></>}</div></div></div>
    }))}/>}
    {open&&<Modal title="إضافة سيارة" onClose={()=>setOpen(false)}>
      <form className="vehicleForm" onSubmit={submit}>
        <VehicleFormProgress vehicle={form}/>
        <VehicleFormSection number="01" title="هوية السيارة" description="اللوحة والماركة والموديل مطلوبة لإنشاء سجل السيارة">
          <Field label="رقم اللوحة" v={form.plate_number} set={v=>setForm({...form,plate_number:v})} requiredMark placeholder="مثال: أ ب ج 1234"/>
          <div className="grid2">
            <Field label="الماركة" v={form.make} set={v=>setForm({...form,make:v})} requiredMark placeholder="مثال: تويوتا"/>
            <Field label="الموديل" v={form.model} set={v=>setForm({...form,model:v})} requiredMark placeholder="مثال: كامري"/>
          </div>
        </VehicleFormSection>
        <VehicleFormSection number="02" title="المواصفات والتسعير" description="أضف التفاصيل التي تساعد الفريق والعملاء على تمييز السيارة">
          <div className="grid2">
            <Field label="سنة الصنع" v={form.model_year} set={v=>setForm({...form,model_year:v})} placeholder="مثال: 2024"/>
            <Field label="اللون" v={form.color} set={v=>setForm({...form,color:v})} placeholder="مثال: أبيض لؤلؤي"/>
            <Select label="حالة السيارة" value={form.condition} onChange={v=>setForm({...form,condition:v})} options={[["NEW","جديد"],["USED","مستعمل"]]}/>
            <Field label="سعر البيع" type="number" v={form.price} set={v=>setForm({...form,price:v})} placeholder="أدخل السعر بالريال"/>
          </div>
          <Field label="رقم الهيكل VIN" v={form.vin} set={v=>setForm({...form,vin:v.replace(/[^A-Za-z0-9]/g,"")})} placeholder="اختياري — أحرف وأرقام فقط"/>
        </VehicleFormSection>
        <VehicleFormSection number="03" title="الملكية" description="حدد ما إذا كانت السيارة للمَعرض أو مملوكة لأحد البائعين">
          <Select label="ملكية السيارة" value={form.ownership_type} onChange={v=>setForm({...form,ownership_type:v,owner_seller_id:"",owner_seller:v==="SHOWROOM"?empty().owner_seller:form.owner_seller})} options={[["SHOWROOM","تخص المعرض"],["THIRD_PARTY","تخص بائع / مملوكة للغير"]]}/>
          {form.ownership_type==="THIRD_PARTY"&&<div className="vehicleOwnerPanel">
            <div className="vehicleOwnerHeading"><span aria-hidden="true">↗</span><div><b>بيانات مالك السيارة</b><small>اختر بائعًا مسجلًا أو أدخل بياناته لأول مرة</small></div></div>
            <Select label="بائع مسجل مسبقًا" value={form.owner_seller_id} onChange={v=>setForm({...form,owner_seller_id:v,owner_seller:empty().owner_seller})} options={sellers.map(x=>[x.id,x.name])}/>
            {!form.owner_seller_id&&<div className="grid2">
              <Field label="اسم البائع" v={form.owner_seller.name} set={v=>updateOwner("name",v)} requiredMark placeholder="الاسم كما في الهوية"/>
              <Field label="رقم الهوية" v={form.owner_seller.national_id} set={v=>updateOwner("national_id",v)}/>
              <Field label="الجوال" v={form.owner_seller.phone} set={v=>updateOwner("phone",v)} placeholder="05xxxxxxxx"/>
              <Field label="المدينة" v={form.owner_seller.city} set={v=>updateOwner("city",v)}/>
              <Field label="العنوان" v={form.owner_seller.address} set={v=>updateOwner("address",v)}/>
            </div>}
          </div>}
        </VehicleFormSection>
        <VehicleFormSection number="04" title="صور السيارة" description="الصور الواضحة تجهّز ملفًا أجمل — يمكنك إضافة حتى 5 صور">
          <ImageUploader images={form.images} onFiles={addImages} onRemove={index=>setForm(current=>({...current,images:current.images.filter((_,i)=>i!==index)}))}/>
        </VehicleFormSection>
        <div className="vehicleFormActions"><button className="primary full">حفظ السيارة</button><span>يمكنك تعديل بيانات السيارة وصورها لاحقًا</span></div>
      </form>
    </Modal>}
    {edit&&<Modal title="تعديل بيانات السيارة" onClose={()=>setEdit(null)}>
      <form className="vehicleForm" onSubmit={saveEdit}>
        <VehicleFormProgress vehicle={edit}/>
        <VehicleFormSection number="01" title="هوية السيارة" description="راجع البيانات الأساسية المرتبطة بسجل السيارة">
          <div className="grid2">
            <Field label="رقم اللوحة" v={edit.plate_number} set={v=>setEdit({...edit,plate_number:v})} requiredMark/>
            <Field label="رقم الهيكل VIN" v={edit.vin} set={v=>setEdit({...edit,vin:v.replace(/[^A-Za-z0-9]/g,"")})}/>
            <Field label="الماركة" v={edit.make} set={v=>setEdit({...edit,make:v})} requiredMark/>
            <Field label="الموديل" v={edit.model} set={v=>setEdit({...edit,model:v})} requiredMark/>
          </div>
        </VehicleFormSection>
        <VehicleFormSection number="02" title="المواصفات والتسعير" description="حدّث التفاصيل والسعر المعروض في المخزون">
          <div className="grid2">
            <Field label="سنة الصنع" v={edit.model_year} set={v=>setEdit({...edit,model_year:v})}/>
            <Field label="اللون" v={edit.color} set={v=>setEdit({...edit,color:v})}/>
            <Select label="حالة السيارة" value={edit.condition||"USED"} onChange={v=>setEdit({...edit,condition:v})} options={[["NEW","جديد"],["USED","مستعمل"]]}/>
            <Field label="سعر البيع" type="number" v={edit.price} set={v=>setEdit({...edit,price:v})}/>
          </div>
        </VehicleFormSection>
        <VehicleFormSection number="03" title="صور السيارة" description="أضف صورًا أو احذف الصور التي لم تعد مناسبة">
          <ImageUploader images={edit.images||[]} onFiles={addEditImages} onRemove={index=>setEdit(current=>({...current,images:(current.images||[]).filter((_,i)=>i!==index)}))}/>
        </VehicleFormSection>
        <VehicleFormSection number="04" title="حالة المخزون" description="حدّث حالة السيارة داخل مخزون المعرض">
          <Select label="حالة المخزون" value={edit.status||"IN_STOCK"} onChange={v=>setEdit({...edit,status:v})} options={[["IN_STOCK","متاحة"],["RESERVED","محجوزة"],["SOLD","مباعة"]]}/>
        </VehicleFormSection>
        <div className="vehicleFormActions"><button className="primary full">حفظ التعديل</button><span>تُحفظ التعديلات مباشرة في سجل السيارة</span></div>
      </form>
    </Modal>}
  </div>
}
export function ImageStrip({images=[],onRemove}){return images.length?<div className="imageStrip">{images.map((src,i)=><div className="imageThumb" key={i}><img src={src} alt={`صورة السيارة ${i+1}`}/>{onRemove&&<button type="button" className="imageRemove" onClick={()=>onRemove(i)} aria-label={`حذف الصورة ${i+1}`}>×</button>}</div>)}</div>:null}

function ImageUploader({images=[],onFiles,onRemove,max=5}){
  const inputRef=useRef(null);
  const [dragging,setDragging]=useState(false);
  const full=images.length>=max;
  const openPicker=()=>{if(!full)inputRef.current?.click()};
  return <>
    <input ref={inputRef} className="imageUploadInput" type="file" accept="image/*" multiple aria-label="اختيار صور السيارة" onChange={async e=>{await onFiles(e.target.files);e.target.value=""}}/>
    <div className={`imageDropzone${dragging?" isDragging":""}${full?" isFull":""}`} role="button" tabIndex={full?-1:0} aria-disabled={full} aria-label={full?"اكتملت صور السيارة":"إضافة صور السيارة"} onClick={openPicker} onKeyDown={e=>{if(!full&&(e.key==="Enter"||e.key===" ")){e.preventDefault();openPicker()}}} onDragOver={e=>{e.preventDefault();if(!full)setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);if(!full)onFiles(e.dataTransfer.files)}}>
      <span className="imageDropzoneIcon" aria-hidden="true">＋</span>
      <span className="imageDropzoneCopy"><b>{dragging?"أفلت الصور هنا":"أضف صورًا توضح السيارة"}</b><span>اسحب الصور إلى هنا أو اخترها من جهازك</span></span>
      <span className="imageUploadCount">{images.length} / {max}</span>
      <span className="imageUploadButton">{full?"اكتملت الصور":"اختيار الصور"}</span>
    </div>
    <ImageStrip images={images} onRemove={onRemove}/>
  </>;
}

function VehicleFormProgress({vehicle}){
  const required=[["plate_number","رقم اللوحة"],["make","الماركة"],["model","الموديل"]];
  const completed=required.filter(([key])=>String(vehicle[key]??"").trim()).length;
  const percent=Math.round(completed/required.length*100);
  const missing=required.filter(([key])=>!String(vehicle[key]??"").trim()).map(([,label])=>label);
  const name=[vehicle.make,vehicle.model].filter(value=>String(value||"").trim()).join(" ")||"سيارة جديدة";
  const details=[vehicle.model_year,vehicle.color].filter(value=>String(value||"").trim()).join(" · ")||"أكمل التفاصيل لتظهر هنا";
  return <div className="vehicleProgressCard">
    <div className="vehicleProgressHeading"><div><span>معاينة مباشرة</span><b>ملف السيارة</b></div><span className="vehicleDraftBadge">مسودة جديدة</span></div>
    <div className="vehiclePreviewRow">
      <span className="vehiclePreviewIcon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path d="m8 26 3-9a4 4 0 0 1 4-3h18a4 4 0 0 1 4 3l3 9v9h-4v-4H12v4H8v-9Z" fill="currentColor" opacity=".14"/><path d="m8 26 3-9a4 4 0 0 1 4-3h18a4 4 0 0 1 4 3l3 9v9h-4v-4H12v4H8v-9Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M11 26h26M15 20h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="15" cy="29" r="2" fill="currentColor"/><circle cx="33" cy="29" r="2" fill="currentColor"/></svg></span>
      <div className="vehiclePreviewDetails"><b>{name}</b><span>{details}</span><small>{vehicle.plate_number||"رقم اللوحة سيظهر هنا"}</small></div>
      <strong className="vehicleProgressPercent">{percent}%</strong>
    </div>
    <div className="vehicleProgressTrack" role="progressbar" aria-label="اكتمال البيانات الأساسية" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent} aria-valuetext={`${completed} من ${required.length} حقول أساسية`}>
      <span style={{width:`${percent}%`}}/>
    </div>
    <div className="vehicleProgressFoot"><span>{missing.length?`المتبقي: ${missing.join("، ")}`:"اكتملت البيانات الأساسية"}</span><bdi dir="ltr">{completed} / {required.length}</bdi></div>
  </div>;
}

function VehicleFormSection({number,title,description,children}){
  return <section className="vehicleFormSection">
    <div className="vehicleSectionHeading"><span>{number}</span><div><h4>{title}</h4><p>{description}</p></div></div>
    <div className="vehicleSectionBody">{children}</div>
  </section>;
}
