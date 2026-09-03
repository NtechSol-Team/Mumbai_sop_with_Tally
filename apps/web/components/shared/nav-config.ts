import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Ruler,
  Factory,
  Boxes,
  ShoppingCart,
  ShoppingBag,
  Wallet,
  BadgeIndianRupee,
  TrendingUp,
  BarChart3,
  Users,
  Landmark,
  Contact,
  Settings,
  BookUp,
} from 'lucide-react';
import type { UserRole } from '@/types/api';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  roles: UserRole[];
}

const ALL: UserRole[] = ['SUPER_ADMIN', 'GODOWN_MANAGER', 'FRANCHISE_OWNER', 'CASHIER'];

// Sidebar order, set by the owner. Roles filter this list without reordering it, so
// every role sees these same modules in the same sequence. "Open POS" isn't here —
// the sidebar renders it separately, always last.
export const navItems: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard, roles: ['SUPER_ADMIN', 'GODOWN_MANAGER', 'FRANCHISE_OWNER'] },
  { label: 'Item Master', href: '/item-master', icon: Ruler, roles: ['SUPER_ADMIN', 'GODOWN_MANAGER'] },
  { label: 'Production', href: '/production', icon: Factory, roles: ['SUPER_ADMIN', 'GODOWN_MANAGER'] },
  { label: 'Inventory', href: '/inventory', icon: Boxes, roles: ['SUPER_ADMIN', 'GODOWN_MANAGER'] },
  // Sales holds Orders + Bills as tabs; a franchise owner still sees only their own outlet's.
  { label: 'Sales', href: '/sales', icon: ShoppingCart, roles: ['SUPER_ADMIN', 'GODOWN_MANAGER', 'FRANCHISE_OWNER'] },
  // A franchise owner keeps their own branch's purchase and expense book. It is a
  // separate set of records from the company's — see shared/utils/books on the API.
  { label: 'Purchases', href: '/purchases', icon: ShoppingBag, roles: ['SUPER_ADMIN', 'GODOWN_MANAGER', 'FRANCHISE_OWNER'] },
  { label: 'Expenses', href: '/expenses', icon: TrendingUp, roles: ['SUPER_ADMIN', 'GODOWN_MANAGER', 'FRANCHISE_OWNER'] },
  { label: 'Payments', href: '/payments', icon: Wallet, roles: ['SUPER_ADMIN', 'FRANCHISE_OWNER', 'GODOWN_MANAGER'] },
  { label: 'Contacts', href: '/contacts', icon: Contact, roles: ['SUPER_ADMIN', 'GODOWN_MANAGER'] },
  { label: 'Accounting', href: '/accounting', icon: Landmark, roles: ['SUPER_ADMIN'] },
  { label: 'Tally Sync', href: '/tally', icon: BookUp, roles: ['SUPER_ADMIN'] },
  { label: 'Analytics', href: '/analytics', icon: BarChart3, roles: ['SUPER_ADMIN', 'FRANCHISE_OWNER'] },
  { label: 'Payroll', href: '/payroll', icon: BadgeIndianRupee, roles: ['SUPER_ADMIN'] },
  { label: 'Users', href: '/users', icon: Users, roles: ['SUPER_ADMIN'] },
  { label: 'Settings', href: '/settings', icon: Settings, roles: ALL },
];

export const POS_HREF = '/pos';

export function navForRole(role: UserRole): NavItem[] {
  return navItems.filter((i) => i.roles.includes(role));
}

export const ROLE_LABEL: Record<UserRole, string> = {
  SUPER_ADMIN: 'Owner',
  GODOWN_MANAGER: 'Warehouse Manager',
  FRANCHISE_OWNER: 'Franchise Owner',
  CASHIER: 'Cashier',
};
