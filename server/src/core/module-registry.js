import { registerVehicleReceiptRoutes } from "../modules/documents/vehicle-receipt.routes.js";
import { registerGeneralRoutes } from "../modules/general/general.routes.js";
import { registerVehiclesRoutes } from "../modules/vehicles/vehicles.routes.js";
import { registerCustomersRoutes } from "../modules/customers/customers.routes.js";
import { registerGuarantorsRoutes } from "../modules/guarantors/guarantors.routes.js";
import { registerSellersRoutes } from "../modules/sellers/sellers.routes.js";
import { registerSalesRoutes } from "../modules/sales/sales.routes.js";
import { registerPaymentsRoutes } from "../modules/payments/payments.routes.js";
import { registerReportsRoutes } from "../modules/reports/reports.routes.js";
import { registerDocumentsRoutes } from "../modules/documents/documents.routes.js";
import { registerMessagingRoutes } from "../modules/messaging/messaging.routes.js";
import { registerLifecycleRoutes } from "../modules/lifecycle/lifecycle.routes.js";
import { registerStaffUserRoutes } from "../modules/security/staff-users.routes.js";

export const domainModules = [
  ["general", registerGeneralRoutes],
  ["vehicles", registerVehiclesRoutes],
  ["customers", registerCustomersRoutes],
  ["guarantors", registerGuarantorsRoutes],
  ["sellers", registerSellersRoutes],
  ["sales", registerSalesRoutes],
  ["payments", registerPaymentsRoutes],
  ["reports", registerReportsRoutes],
  ["documents", registerDocumentsRoutes],
  ["vehicle-receipt", registerVehicleReceiptRoutes],
  ["messaging", registerMessagingRoutes],
  ["lifecycle", registerLifecycleRoutes],
  ["staff-users", registerStaffUserRoutes],
];

export function registerDomainModules(app, context) {
  for (const [, register] of domainModules) register(app, context);
}
