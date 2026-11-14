import React,{useEffect,useState} from "react";
import {api,money} from "../services/api.js";
import {LoadError,Loading,Table,Stat,Status} from "../components/ui.jsx";

export function Dashboard({refresh,onNavigate}) {
  const [d,setD]=useState(null);
  useEffect(()=>{let alive=true; api("/dashboard").then(x=>alive&&setD(x)).catch(e=>alive&&setD({error:e.message})); return ()=>{alive=false};},[refresh]);
  if(!d) return <Loading/>;
  if(d.error) return <LoadError error={d.error} onRetry={()=>window.location.reload()}/>;
  const cards=[
    ["قيمة المخزون",`${money(d.inventory_value)} ريال`],
    ["السيارات المتاحة",d.available],
    ["المحجوزة",d.reserved],
    ["المباعة",d.sold],
    ["الأقساط المستحقة",`${money(d.outstanding)} ريال`],
    ["المتأخرات",`${money(d.overdue_amount)} ريال`],
    ["تحصيل اليوم",`${money(d.collections_today)} ريال`],
    ["تحصيل الشهر",`${money(d.collections_month)} ريال`],
    ["مصروفات الشهر",`${money(d.expenses_month)} ريال`],
    ["مستحقات البائعين",`${money(d.seller_due)} ريال`]
  ];
  const inventoryCards=cards.slice(0,4),financialCards=cards.slice(4);
  const inventory=[
    {label:"متاحة",value:Number(d.available)||0,tone:"available"},
    {label:"محجوزة",value:Number(d.reserved)||0,tone:"reserved"},
    {label:"مباعة",value:Number(d.sold)||0,tone:"sold"},
  ];
  const totalInventory=inventory.reduce((total,item)=>total+item.value,0);
  const maxInventory=Math.max(1,...inventory.map(item=>item.value));
  return <div>
    <section className="dashboardWelcome" aria-labelledby="dashboard-welcome-title">
      <div className="dashboardWelcomeCopy"><span className="dashboardEyebrow">لوحة المتابعة</span><h2 id="dashboard-welcome-title">كل تفاصيل المعرض في لمحة</h2><p>تابع مخزونك ومؤشراتك المالية، وانتقل مباشرةً إلى المهام اليومية.</p></div>
      <div className="dashboardActions" aria-label="اختصارات سريعة">
        <button type="button" onClick={()=>onNavigate("vehicles")}>🚘 السيارات</button>
        <button type="button" onClick={()=>onNavigate("sales")}>🧾 المبيعات</button>
        <button type="button" onClick={()=>onNavigate("collections")}>💰 التحصيلات</button>
        <button type="button" onClick={()=>onNavigate("reports")}>📊 التقارير</button>
      </div>
    </section>
    <section aria-labelledby="inventory-stats-title">
      <div className="dashboardSectionTitle"><div><h2 id="inventory-stats-title">حالة المخزون</h2><p>ملخص السيارات وقيمتها الحالية</p></div><span>٤ مؤشرات</span></div>
      <div className="cards">{inventoryCards.map(([t,v])=><Stat key={t} title={t} value={v}/>)}</div>
    </section>
    <section aria-labelledby="financial-stats-title">
      <div className="dashboardSectionTitle"><div><h2 id="financial-stats-title">المؤشرات المالية</h2><p>المستحقات والتحصيلات والمصروفات</p></div><span>٦ مؤشرات</span></div>
      <div className="cards">{financialCards.map(([t,v])=><Stat key={t} title={t} value={v}/>)}</div>
    </section>
    <div className="grid2 dashboardPanels">
      <section className="panel inventoryChartPanel">
        <div className="panelTitle inventoryPanelTitle"><div><h3>توزيع السيارات</h3><span className="muted">حسب الحالة الحالية</span></div><div className="inventoryTotal"><b>{totalInventory}</b><span>إجمالي السيارات</span></div></div>
        <div className="inventoryChart" role="img" aria-label={`متاحة ${inventory[0].value}، محجوزة ${inventory[1].value}، مباعة ${inventory[2].value}`}>
          <div className="inventoryBars">{inventory.map(item=><div className="inventoryBarColumn" key={item.label}><b>{item.value}</b><div className="inventoryBarTrack"><span className={`inventoryBarFill ${item.tone}`} style={{height:`${item.value/maxInventory*100}%`}}/></div><span>{item.label}</span></div>)}</div>
          <div className="inventoryChartNote"><span className="chartPulse" aria-hidden="true"/>ملخص مرئي لحالة أسطولك</div>
        </div>
      </section>
      <section className="panel"><div className="panelTitle"><h3>مستحقات البائعين</h3></div><div className="summary"><div>المبالغ المستحقة <b>{money(d.seller_due)} ريال</b></div><div>تنبيه <span>تظهر هنا مستحقات ملاك السيارات من الغير فقط</span></div></div></section>
      <section className="panel"><div className="panelTitle"><h3>اليوم</h3></div><div className="summary"><div>أقساط مستحقة <b>{d.dueToday}</b></div><div>متأخرات <b>{d.overdue_count}</b></div><div>مصروفات <b>{money(d.expenses_today)} ريال</b></div></div></section>
    </div>
    <section className="panel"><div className="panelTitle"><h3>أقرب الاستحقاقات والمتأخرات</h3></div>
      <Table headers={["العميل","العقد","القسط","الاستحقاق","التأخير","المتبقي","الحالة"]} rows={d.upcoming.map(x=>[x.customer_name,x.contract_number,x.installment_number,x.due_date,x.overdue_days?`${x.overdue_days} يوم`:"-",`${money(x.amount-x.paid_amount)} ريال`,<Status s={x.status}/>])}/>
    </section>
  </div>
}

