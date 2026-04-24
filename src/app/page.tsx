'use client';

import { useEffect, useState } from 'react';
import { Layout, Typography, Space, Tag, Button, App as AntApp, Divider, Drawer } from 'antd';
import {
  BookOutlined,
  ReadOutlined,
  ShareAltOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { ReaderPane } from '@/app/components/reader/ReaderPane';
import { MaterialImportModal } from '@/app/components/reader/MaterialImportModal';
import { ApiKeysPanel } from '@/app/components/settings/ApiKeysPanel';
import { useWordStore, hydrateFromDb } from '@/app/stores/wordStore';
import {
  FirstLaunchWizard,
  needsFirstLaunchWizard,
} from '@/app/components/onboarding/FirstLaunchWizard';
import { isTauri } from '@/app/lib/ipc';

const { Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

const DEMO_TEXT = `Curiosity is the engine of every vocabulary you will ever own. Pick up a book, notice the words that snag your attention, and start turning strangers into acquaintances one sentence at a time. The network grows whether you are watching it or not.`;

export default function Home() {
  const { message } = AntApp.useApp();
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readerSeed, setReaderSeed] = useState<string>(DEMO_TEXT);
  const knownCount = useWordStore((s) => s.known.size);
  const hydrated = useWordStore((s) => s.hydrated);
  const [wizardOpen, setWizardOpen] = useState(false);

  // Hydrate known-set from the DB on first mount; show the first-launch wizard
  // if the user has never picked a cutoff.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isTauri() && (await needsFirstLaunchWizard())) {
          if (!cancelled) setWizardOpen(true);
          return; // wizard's onFinish triggers the hydrate
        }
        await hydrateFromDb();
      } catch (err) {
        console.warn('[wordbrain] startup hydrate skipped', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        width={220}
        theme="light"
        style={{ borderRight: '1px solid rgba(0,0,0,0.06)' }}
      >
        <div style={{ padding: 20 }}>
          <Title level={4} style={{ margin: 0 }}>
            WordBrain
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            v0.1.0 · Phase 1
          </Text>
        </div>
        <Space direction="vertical" style={{ padding: '0 12px', width: '100%' }} size={4}>
          <SidebarEntry icon={<BookOutlined />} label="Library" disabled />
          <SidebarEntry icon={<ReadOutlined />} label="Reader" active />
          <SidebarEntry icon={<ThunderboltOutlined />} label="Review" disabled />
          <SidebarEntry icon={<ShareAltOutlined />} label="Network" disabled />
          <div onClick={() => setSettingsOpen(true)}>
            <SidebarEntry icon={<SettingOutlined />} label="Settings" />
          </div>
        </Space>
        <Divider style={{ margin: '24px 12px' }} />
        <div style={{ padding: '0 20px' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Known words
          </Text>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{knownCount.toLocaleString()}</div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {hydrated ? 'hydrated from Turso SQLite' : 'using Phase-1 fallback seed'}
          </Text>
        </div>
      </Sider>

      <Content style={{ padding: 40, maxWidth: 960, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>
              Reader
            </Title>
            <Text type="secondary">
              Unknown words are highlighted. Click one to mark it known.
            </Text>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            Paste reading material
          </Button>
        </div>

        <Tag color="processing" style={{ marginBottom: 16 }}>
          Phase 1 · Tiptap + tokenizer + ProseMirror decorations active
        </Tag>

        <ReaderPane initialContent={readerSeed} />

        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16 }}>
          Dictionary lookups, persistence, and the FSRS review queue ship in later phases — see
          <Text code>.omc/plans/wordbrain-v1.md</Text>.
        </Paragraph>
      </Content>

      <Drawer
        title="Settings"
        placement="right"
        width={520}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      >
        <ApiKeysPanel />
      </Drawer>

      <MaterialImportModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onSubmit={(raw) => {
          setReaderSeed(raw);
          setImportOpen(false);
          message.success(`Loaded ${raw.length.toLocaleString()} chars into reader`);
        }}
      />
    </Layout>
  );
}

function SidebarEntry({
  icon,
  label,
  disabled,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <div
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: disabled ? 'rgba(0,0,0,0.35)' : active ? '#4f46e5' : 'inherit',
        background: active ? 'rgba(79,70,229,0.08)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}
