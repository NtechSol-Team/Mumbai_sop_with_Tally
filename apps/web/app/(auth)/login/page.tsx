'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Store className="h-6 w-6" />
          </div>
          <h1 className="text-page-heading font-bold">Mumbai ERP</h1>
          <p className="text-body text-muted-foreground">
            Franchise ordering &amp; billing portal. Sign in to your partner account.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="identifier" required>
                Email or User ID
              </Label>
              <Input
                id="identifier"
                placeholder="admin@mumbaierp.local or ADMIN001"
                autoComplete="username"
                aria-invalid={!!errors.identifier}
                {...register('identifier')}
              />
              {errors.identifier && <p className="text-caption text-danger">{errors.identifier.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" required>
                Password
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                aria-invalid={!!errors.password}
                {...register('password')}
              />
              {errors.password && <p className="text-caption text-danger">{errors.password.message}</p>}
            </div>

            <Button type="submit" size="lg" className="w-full" loading={login.isPending}>
              Sign In
            </Button>
          </form>

          {process.env.NODE_ENV === 'development' && (
            <div className="mt-6 rounded-md bg-surface p-3 text-caption text-muted-foreground">
              <p className="font-medium text-foreground">Demo accounts</p>
              <p>Admin: ADMIN001 / Admin@123</p>
              <p>Owner: OWNER001 / Owner@123</p>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <span>© {new Date().getFullYear()} Mumbai ERP · Mumbai, Maharashtra</span>
        <a href="/terms" className="hover:text-foreground hover:underline">Terms</a>
        <a href="/privacy" className="hover:text-foreground hover:underline">Privacy</a>
        <a href="/refunds" className="hover:text-foreground hover:underline">Refunds</a>
      </p>
    </div>
  );
}
