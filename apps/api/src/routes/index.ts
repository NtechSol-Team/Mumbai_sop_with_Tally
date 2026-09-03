import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes';
import { usersRouter } from '../modules/users/users.routes';
import { analyticsRouter } from '../modules/analytics/analytics.routes';
import { categoriesRouter, productsRouter, rawMaterialsRouter } from '../modules/products/products.routes';
import { unitsRouter } from '../modules/units/units.routes';
import { productionRouter } from '../modules/production/production.routes';
import { transfersRouter } from '../modules/transfers/transfers.routes';
import { ordersRouter } from '../modules/orders/orders.routes';
import { billingRouter } from '../modules/billing/billing.routes';
import { paymentsRouter, paymentsWebhookRouter } from '../modules/payments/payments.routes';
import { expensesRouter } from '../modules/expenses/expenses.routes';
import { posRouter } from '../modules/pos/pos.routes';
import { menusRouter } from '../modules/menus/menus.routes';
import { outletsRouter } from '../modules/outlets/outlets.routes';
import { inventoryRouter } from '../modules/inventory/inventory.routes';
import { accountingRouter } from '../modules/accounting/accounting.routes';
import { payablesRouter } from '../modules/payables/payables.routes';
import { contactsRouter } from '../modules/contacts/contacts.routes';
import { assetsRouter } from '../modules/assets/assets.routes';
import { employeesRouter, shiftsRouter } from '../modules/employees/employees.routes';
import { payrollRouter } from '../modules/payroll/payroll.routes';
import { settingsRouter } from '../modules/settings/settings.routes';
import { tallyRouter } from '../modules/tally/tally.routes';
import { developerPaymentsRouter } from '../modules/developer-payments/developer-payments.routes';
import { developerPresenceRouter } from '../modules/developer-presence/developer-presence.routes';
import { developerMetricsRouter } from '../modules/developer-metrics/developer-metrics.routes';
import { developerExpensesRouter } from '../modules/developer-expenses/developer-expenses.routes';

/**
 * Central API router. Feature module routers are mounted here as they are built
 * (products, production, transfers, orders, billing, payments, expenses, pos,
 * analytics).
 */
export function buildApiRouter(): Router {
  const router = Router();

  router.use('/auth', authRouter);
  router.use('/users', usersRouter);
  router.use('/analytics', analyticsRouter);
  router.use('/categories', categoriesRouter);
  router.use('/units', unitsRouter);
  router.use('/products', productsRouter);
  router.use('/raw-materials', rawMaterialsRouter);
  router.use('/production', productionRouter);
  router.use('/transfers', transfersRouter);
  router.use('/orders', ordersRouter);
  router.use('/billing', billingRouter);
  router.use('/payments', paymentsWebhookRouter); // unauthenticated, signature-verified
  router.use('/payments', paymentsRouter);
  router.use('/expenses', expensesRouter);
  router.use('/pos', posRouter);
  router.use('/menus', menusRouter);
  router.use('/outlets', outletsRouter);
  router.use('/inventory', inventoryRouter);
  router.use('/accounting', accountingRouter);
  router.use('/payables', payablesRouter);
  router.use('/contacts', contactsRouter);
  router.use('/assets', assetsRouter);
  router.use('/employees', employeesRouter);
  router.use('/shifts', shiftsRouter);
  router.use('/payroll', payrollRouter);
  router.use('/settings', settingsRouter);
  router.use('/tally', tallyRouter);
  router.use('/developer-payments', developerPaymentsRouter);
  router.use('/developer-presence', developerPresenceRouter);
  router.use('/developer-metrics', developerMetricsRouter);
  router.use('/developer-expenses', developerExpensesRouter);

  return router;
}
