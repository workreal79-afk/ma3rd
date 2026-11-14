export const NAV_ITEMS = Object.freeze([
  ["dashboard", "الرئيسية", "⌂"],
  ["vehicles", "السيارات", "🚗"],
  ["customers", "المشترون", "👤"],
  ["sellers", "البائعون", "🧑‍💼"],
  ["parties", "الكفلاء", "👥"],
  ["sales", "المبيعات", "🧾"],
  ["collections", "الأقساط والتحصيل", "💰"],
  ["expenses", "المصروفات", "💸"],
  ["reports", "التقارير", "📊"],
  ["audit", "سجل الحركات", "📝"],
  ["messaging", "واتساب والتنبيهات", "📲"],
  ["users", "المستخدمون والصلاحيات", "🔐"],
]);

export const NAV_GROUPS = Object.freeze([
  { id: "home", title: "", ids: ["dashboard"] },
  { id: "management", title: "إدارة المعرض", ids: ["vehicles", "customers", "sellers", "parties"] },
  { id: "operations", title: "العمليات", ids: ["sales", "collections", "expenses"] },
  { id: "follow-up", title: "المتابعة والأدوات", ids: ["reports", "audit", "messaging", "users"] },
]);
