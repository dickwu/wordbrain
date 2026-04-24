'use client';

import { Layout, Typography, Space, Tag, App as AntApp } from 'antd';
import {
  BookOutlined,
  ReadOutlined,
  ShareAltOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

const { Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

export default function Home() {
  const { message } = AntApp.useApp();

  const phaseStatus = [
    { label: 'Phase 0: Fork & rename', done: true },
    { label: 'Phase 1: Tiptap highlight loop', done: false },
    { label: 'Phase 1.5: Frequency seeding', done: false },
    { label: 'Phase 2: Dictionary stack', done: false },
    { label: 'Phase 3: Library + bipartite edges', done: false },
    { label: 'Phase 4: FSRS review queue', done: false },
    { label: 'Phase 5: EPUB + .srt', done: false },
    { label: 'Phase 6: Network graph', done: false },
    { label: 'Phase 7: Packaging + release', done: false },
  ];

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
            v0.1.0 · Phase 0
          </Text>
        </div>
        <Space direction="vertical" style={{ padding: '0 12px', width: '100%' }} size={4}>
          <SidebarEntry icon={<BookOutlined />} label="Library" disabled />
          <SidebarEntry icon={<ReadOutlined />} label="Reader" disabled />
          <SidebarEntry icon={<ThunderboltOutlined />} label="Review" disabled />
          <SidebarEntry icon={<ShareAltOutlined />} label="Network" disabled />
          <SidebarEntry icon={<SettingOutlined />} label="Settings" disabled />
        </Space>
      </Sider>

      <Content style={{ padding: 48, maxWidth: 820 }}>
        <Title>Welcome to WordBrain</Title>
        <Paragraph>
          A local-first English vocabulary builder. Paste or drop in reading material, and the
          editor will highlight every unfamiliar word based on your personal known-word list.
          Click a word to see its Chinese meaning, mark it as learned, or add it to the FSRS
          review queue. Every exposure is recorded so your word network densifies over time.
        </Paragraph>

        <Title level={4}>Build status</Title>
        <Space direction="vertical" size={4}>
          {phaseStatus.map((p) => (
            <div key={p.label}>
              <Tag color={p.done ? 'success' : 'default'}>{p.done ? 'DONE' : 'TODO'}</Tag>
              <Text>{p.label}</Text>
            </div>
          ))}
        </Space>

        <Paragraph style={{ marginTop: 32 }}>
          <Text type="secondary">
            This is the Phase 0 baseline — a clean Tauri + Next.js skeleton renamed from the r2
            template. The Tiptap reading loop arrives in Phase 1.
          </Text>
        </Paragraph>

        <button
          onClick={() => message.info('Phase 1 not implemented yet')}
          style={{
            marginTop: 16,
            padding: '8px 16px',
            border: '1px solid #4f46e5',
            borderRadius: 6,
            background: '#4f46e5',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Paste reading material
        </button>
      </Content>
    </Layout>
  );
}

function SidebarEntry({
  icon,
  label,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: disabled ? 'rgba(0,0,0,0.35)' : 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}
