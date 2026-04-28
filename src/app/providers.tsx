'use client';

import { useEffect, useMemo, useState } from 'react';
import { App, ConfigProvider, theme } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { startSystemThemeListener, useEffectiveTheme } from '@/app/stores/themeStore';

// Editorial palette mirrors `globals.css`. We feed it to AntD so dropdowns,
// modals, popovers, tables, etc. land on the same paper / ink colours as the
// hand-rolled chrome.
const PAPER_LIGHT = {
  paper: '#f6f1e7',
  paper2: '#efe9dc',
  paper3: '#e7e0cf',
  ink: '#1f1a14',
  ink2: '#3b3327',
  ink3: '#6b6052',
  ink4: '#9c9384',
  rule: '#d9cfb9',
  ruleSoft: '#e8e0cf',
  accent: '#8a4a23',
};
const PAPER_DARK = {
  paper: '#1a1714',
  paper2: '#221e1a',
  paper3: '#2a2520',
  ink: '#ece4d4',
  ink2: '#c8bea9',
  ink3: '#948a78',
  ink4: '#6b6356',
  rule: '#3a3329',
  ruleSoft: '#2e2924',
  accent: '#d99873',
};

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
    document.documentElement.setAttribute('data-theme', effective);
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

  const antTheme = useMemo(() => {
    const p = effective === 'dark' ? PAPER_DARK : PAPER_LIGHT;
    return {
      algorithm: effective === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        colorPrimary: p.accent,
        colorInfo: p.accent,
        colorBgBase: p.paper,
        colorBgLayout: p.paper,
        colorBgContainer: p.paper,
        colorBgElevated: p.paper,
        colorTextBase: p.ink,
        colorText: p.ink,
        colorTextSecondary: p.ink3,
        colorTextTertiary: p.ink4,
        colorBorder: p.rule,
        colorBorderSecondary: p.ruleSoft,
        colorSplit: p.rule,
        borderRadius: 8,
        borderRadiusSM: 6,
        borderRadiusLG: 10,
        fontFamily:
          'var(--font-sans), -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
        fontFamilyCode: 'var(--font-mono), ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
      },
      components: {
        Layout: {
          headerBg: p.paper,
          siderBg: p.paper,
          bodyBg: p.paper,
          footerBg: p.paper2,
        },
        Menu: {
          itemBg: 'transparent',
          itemSelectedBg: p.paper3,
          itemHoverBg: p.paper2,
          itemSelectedColor: p.ink,
        },
      },
    };
  }, [effective]);

  if (!mounted) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={antTheme}>
        <App>{children}</App>
      </ConfigProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
