'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ArrowRight, Eye, EyeOff, Layers3, Boxes, ChartNoAxesCombined, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Brand } from '@/components/shared/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/hooks/useAuth';
import { useAuthStore } from '@/store/auth.store';
import { apiErrorMessage } from '@/lib/api';

const schema = z.object({
  identifier: z.string().min(3, 'Enter your email or user ID'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const login = useLogin();
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const role = useAuthStore((s) => s.user?.role);

  useEffect(() => {
    if (token) router.replace(role === 'CASHIER' ? '/pos' : '/');
  }, [token, role, router]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), mode: 'onBlur' });

  const onSubmit = (values: FormValues) => {
    login.mutate(values, {
      onError: (err) => toast.error(apiErrorMessage(err, 'Login failed')),
    });
  };

  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-[1fr_1fr]">
      <section className="flex min-h-screen flex-col px-6 py-8 sm:px-12 lg:px-[12%]">
        <Brand className="self-start" />
        <div className="arthx-enter mx-auto flex w-full max-w-[390px] flex-1 flex-col justify-center py-16">
          <span className="mb-5 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">Your business. Connected.</span>
          <h1 className="text-4xl font-semibold tracking-tight text-slate-900">Welcome back.</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Sign in to your Arthx ERP workspace and pick up where you left off.</p>
          <form onSubmit={handleSubmit(onSubmit)} className="mt-9 space-y-5" noValidate>
            <div className="space-y-2">
              <Label htmlFor="identifier">Email or user ID</Label>
              <Input id="identifier" placeholder="Enter your email or user ID" autoComplete="username" className="h-12 bg-slate-50/70" aria-invalid={!!errors.identifier} aria-describedby={errors.identifier ? 'identifier-error' : undefined} {...register('identifier')} />
              {errors.identifier && <p id="identifier-error" role="alert" className="text-caption text-danger">{errors.identifier.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input id="password" type={showPassword ? 'text' : 'password'} placeholder="Enter your password" autoComplete="current-password" className="h-12 bg-slate-50/70 pr-12" aria-invalid={!!errors.password} aria-describedby={errors.password ? 'password-error' : undefined} {...register('password')} />
                <button type="button" onClick={() => setShowPassword((show) => !show)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} className="absolute right-1 top-1 rounded-md p-3 text-slate-500 hover:text-primary">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </div>
              {errors.password && <p id="password-error" role="alert" className="text-caption text-danger">{errors.password.message}</p>}
            </div>
            <Button type="submit" size="lg" className="w-full justify-between text-sm shadow-lg shadow-blue-900/10" loading={login.isPending}><span>Sign in to workspace</span><ArrowRight className="h-4 w-4" /></Button>
          </form>
          <p className="mt-6 text-center text-xs leading-5 text-muted-foreground">Need access or help signing in?<br />Contact your workspace administrator.</p>
          <div className="mt-9 flex items-center justify-center gap-2 border-t border-border pt-6 text-xs text-slate-500"><ShieldCheck className="h-4 w-4 text-primary" /> Access tailored to your role</div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-4 text-[11px] text-muted-foreground"><span>© {new Date().getFullYear()} Arthx ERP</span><div className="flex gap-4"><Link href="/terms" className="hover:text-primary">Terms</Link><Link href="/privacy" className="hover:text-primary">Privacy</Link><Link href="/refunds" className="hover:text-primary">Refunds</Link></div></footer>
      </section>
      <section className="arthx-hero relative hidden flex-col justify-between p-12 text-white lg:flex xl:p-16">
        <div className="arthx-grid absolute inset-0 -z-10" aria-hidden="true" />
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-blue-200"><span className="h-1.5 w-1.5 rounded-full bg-blue-300" /> The Arthx workspace</div>
        <div className="py-12">
          <p className="mb-5 text-xs font-medium uppercase tracking-[0.2em] text-blue-300">Clarity at every level</p>
          <h2 className="max-w-lg text-5xl font-medium leading-[1.14] tracking-[-0.04em] xl:text-6xl">One business.<br />Every moving part.<br /><span className="text-blue-300">In sync.</span></h2>
          <p className="mt-6 max-w-sm text-sm leading-7 text-blue-100/75">Bring your operations, finance, and franchise network together. Less switching. A clearer view of what matters.</p>
          <div className="mt-12 rounded-2xl border border-white/15 bg-white/[0.04] p-6">
            <div className="mb-5 flex items-center justify-between border-b border-white/10 pb-5"><span className="text-sm font-medium">Built around your business</span><Layers3 className="h-5 w-5 text-blue-300" /></div>
            <div className="space-y-5">
              {[{icon: Boxes, label:'Operations', text:'Inventory, production & orders'}, {icon: ChartNoAxesCombined, label:'Finance', text:'Purchases, payments & accounting'}, {icon: Layers3, label:'Franchise network', text:'Your outlets, working together'}].map(({icon:Icon,label,text}) => <div key={label} className="flex items-center gap-4"><div className="rounded-lg border border-white/10 bg-blue-400/10 p-2.5 text-blue-200"><Icon className="h-4 w-4" /></div><div><p className="text-sm font-medium">{label}</p><p className="mt-1 text-xs text-blue-100/60">{text}</p></div></div>)}
            </div>
          </div>
        </div>
        <div className="flex justify-between text-[10px] uppercase tracking-[0.18em] text-blue-200/60"><span>Precision in every process</span><span>Arthx ERP</span></div>
      </section>
    </div>
  );
}
