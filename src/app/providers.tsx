'use client';

import { useState, useEffect } from 'react';
import { App, ConfigProvider, theme } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useEffectiveTheme, startSystemThemeListener } from '@/app/stores/themeStore';

export default function Providers({ children }: { children: React.ReactNode }) {
  const effective = useEffectiveTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stop = startSystemThemeListener();
    setMounted(true);
    return stop;
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', effective === 'dark');
    // Hint native form controls + scrollbars to match the theme.
    document.documentElement.style.colorScheme = effective;
  }, [effective]);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  if (!mounted) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        theme={{
          algorithm: effective === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: {
            colorPrimary: '#4f46e5',
          },
        }}
      >
        <App>{children}</App>
      </ConfigProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
