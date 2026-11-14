import React,{useEffect,useRef,useState} from "react";
import {api} from "../services/api.js";

const PAGE_FOR_TYPE={customer:"customers",seller:"sellers",vehicle:"vehicles",sale:"sales"};

// اختيار نتيجة كان ينقل للصفحة فقط دون تمرير كلمة البحث أو فتح السجل المعني،
// فيجد المستخدم نفسه أمام جدول كامل ويبحث يدويًا مرة أخرى.
export function GlobalSearch({onNavigate}){
 const [q,setQ]=useState("");
 const [results,setResults]=useState([]);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const [activeIndex,setActiveIndex]=useState(-1);
 const inputRef=useRef(null);
 useEffect(()=>{
  const term=q.trim();
  setActiveIndex(-1);
  setError("");
  if(!term){setResults([]);setLoading(false);return}
  const controller=new AbortController();
  let current=true;
  setResults([]);
  setLoading(true);
  const timer=setTimeout(()=>{
   api(`/search?q=${encodeURIComponent(term)}`,{signal:controller.signal})
    .then(data=>{if(current)setResults(data)})
    .catch(err=>{if(current&&err.name!=="AbortError"){setResults([]);setError(err.message||"تعذر تنفيذ البحث")}})
    .finally(()=>{if(current)setLoading(false)});
  },250);
  return()=>{current=false;clearTimeout(timer);controller.abort()};
 },[q]);
 const clear=()=>{setQ("");setResults([]);setError("");setActiveIndex(-1);inputRef.current?.focus()};
 const choose=x=>{
  const term=q.trim();
  clear();
  onNavigate(PAGE_FOR_TYPE[x.type]||"dashboard",{query:term,id:x.id,type:x.type,title:x.title});
 };
 const onKeyDown=e=>{
  if(e.key==="Escape"){if(q){e.preventDefault();clear()}return}
  if(e.key==="ArrowDown"&&results.length){e.preventDefault();setActiveIndex(i=>(i+1)%results.length)}
  else if(e.key==="ArrowUp"&&results.length){e.preventDefault();setActiveIndex(i=>i<=0?results.length-1:i-1)}
  else if(e.key==="Enter"&&activeIndex>=0&&results[activeIndex]){e.preventDefault();choose(results[activeIndex])}
 };
 const hasQuery=Boolean(q.trim());
 return <div className="globalSearch">
  <input
   ref={inputRef}
   value={q}
   onChange={e=>{setActiveIndex(-1);setQ(e.target.value)}}
   onKeyDown={onKeyDown}
   placeholder="بحث سريع: عميل، لوحة، جوال، هوية، أو رقم بيع..."
   aria-label="بحث سريع عن عميل أو سيارة أو عملية بيع"
   role="combobox"
   aria-autocomplete="list"
   aria-expanded={hasQuery}
   aria-controls={!loading&&!error&&results.length?"global-search-options":undefined}
   aria-activedescendant={activeIndex>=0?`global-search-option-${activeIndex}`:undefined}
  />
  {hasQuery&&<button type="button" className="searchClear" onClick={clear} aria-label="مسح البحث">×</button>}
  {hasQuery&&<div className="searchResults" id="global-search-results" aria-live="polite">
   {loading&&<div className="searchMessage" role="status"><span className="searchSpinner" aria-hidden="true"/>جارٍ البحث...</div>}
   {!loading&&error&&<div className="searchMessage searchMessageError" role="alert">{error}</div>}
   {!loading&&!error&&!results.length&&<div className="searchMessage" role="status">لا توجد نتائج مطابقة.</div>}
   {!loading&&!error&&results.length>0&&<div id="global-search-options" role="listbox" aria-label="نتائج البحث">{results.map((x,i)=><button
    type="button"
    role="option"
    aria-selected={activeIndex===i}
    id={`global-search-option-${i}`}
    className={activeIndex===i?"active":""}
    key={`${x.type}-${x.id}-${i}`}
    onMouseEnter={()=>setActiveIndex(i)}
    onClick={()=>choose(x)}
   ><b>{x.title}</b><span>{x.subtitle}</span></button>)}</div>}
  </div>}
 </div>
}
