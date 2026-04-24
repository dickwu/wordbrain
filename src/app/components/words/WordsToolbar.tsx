'use client';

import { Button, Input, Segmented, Select, Space, Typography } from 'antd';
import { AddWordInput } from './AddWordInput';

const { Text } = Typography;

export type StateFilter = 'all' | 'known' | 'learning';

interface WordsToolbarProps {
  stateFilter: StateFilter;
  onStateFilterChange: (v: StateFilter) => void;
  sources: string[];
  onSourcesChange: (v: string[]) => void;
  search: string;
  onSearchChange: (v: string) => void;
  onAdd: (lemma: string) => Promise<void> | void;
  selectionCount: number;
  onBulkUnmark: () => void;
  totalCount: number;
  filteredCount: number;
  onFocusSearch?: (ref: HTMLInputElement | null) => void;
}

const STATE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'known', label: 'Known' },
  { value: 'learning', label: 'Learning' },
];

const SOURCE_OPTIONS = [
  { value: 'frequency_seed', label: 'frequency_seed' },
  { value: 'manual', label: 'manual' },
  { value: 'manual_list', label: 'manual_list' },
  { value: 'review_graduated', label: 'review_graduated' },
  { value: 'auto_exposure', label: 'auto_exposure' },
  { value: 'srs', label: 'srs' },
];

export function WordsToolbar({
  stateFilter,
  onStateFilterChange,
  sources,
  onSourcesChange,
  search,
  onSearchChange,
  onAdd,
  selectionCount,
  onBulkUnmark,
  totalCount,
  filteredCount,
  onFocusSearch,
}: WordsToolbarProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Space wrap size={12} align="center">
        <Space.Compact>
          <Input.Search
            allowClear
            placeholder="Search by prefix"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onSearch={onSearchChange}
            ref={(el) => onFocusSearch?.(el?.input ?? null)}
            style={{ width: 240 }}
          />
        </Space.Compact>
        {search.trim().length > 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {filteredCount.toLocaleString()} of {totalCount.toLocaleString()}
          </Text>
        )}
        <Segmented
          options={STATE_OPTIONS}
          value={stateFilter}
          onChange={(v) => onStateFilterChange(v as StateFilter)}
        />
        <Select
          mode="multiple"
          allowClear
          placeholder="All sources"
          value={sources}
          onChange={onSourcesChange}
          options={SOURCE_OPTIONS}
          style={{ minWidth: 220 }}
          maxTagCount="responsive"
        />
        <AddWordInput onAdd={onAdd} />
        {selectionCount > 0 && (
          <Space style={{ marginLeft: 'auto' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {selectionCount} selected
            </Text>
            <Button danger onClick={onBulkUnmark}>
              Unmark Selected
            </Button>
          </Space>
        )}
      </Space>
    </div>
  );
}
