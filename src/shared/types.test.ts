import { describe, expect, it } from 'vitest';
import { isAttachmentPayloadList, isCaptureAndSendInput, isConfigPatch, isCaptureRegion, isPlaceholderConversationTitle, summarizeConversationTitle } from './types';

describe('IPC validators', () => {
  it('accepts bounded capture input', () => {
    expect(isCaptureRegion({ x: 0, y: 0, width: 100, height: 80 })).toBe(true);
    expect(isCaptureAndSendInput({ text: 'inspect', region: { x: 1, y: 2, width: 3, height: 4 } })).toBe(true);
    expect(isCaptureAndSendInput({ text: 'inspect', selectRegion: true })).toBe(true);
  });
  it('rejects malformed config and capture values', () => {
    expect(isConfigPatch({ opacity: '1' })).toBe(false);
    expect(isCaptureRegion({ x: 0, y: 0, width: 0, height: 10 })).toBe(false);
    expect(isCaptureAndSendInput({ region: { x: 0 } })).toBe(false);
    expect(isCaptureAndSendInput({ selectRegion: 'true' })).toBe(false);
    expect(isCaptureAndSendInput({ selectRegion: true, region: { x: 0, y: 0, width: 20, height: 20 } })).toBe(false);
    expect(isConfigPatch({ language: 'fr-FR' })).toBe(false);
    expect(isConfigPatch({ language: 'en-US' })).toBe(true);
  });

  it('recognizes draft conversation placeholder titles without matching normal titles', () => {
    expect(isPlaceholderConversationTitle('New conversation')).toBe(true);
    expect(isPlaceholderConversationTitle('New API conversation')).toBe(true);
    expect(isPlaceholderConversationTitle('New chat')).toBe(true);
    expect(isPlaceholderConversationTitle('新建会话')).toBe(true);
    expect(isPlaceholderConversationTitle('新建对话')).toBe(true);
    expect(isPlaceholderConversationTitle('Summarize a screenshot')).toBe(false);
  });

  it('summarizes Chinese and English prompts without waiting for a model', () => {
    expect(summarizeConversationTitle('请帮我分析订单页面的错误。然后给出修复建议。', 'zh-CN')).toBe('分析订单页面的错误');
    expect(summarizeConversationTitle('Please explain why the build is failing.', 'en-US')).toBe('explain why the build is failing');
    expect(summarizeConversationTitle('请分析这张截图。', 'zh-CN')).toBe('截图分析');
    expect(summarizeConversationTitle('Please analyze this screenshot.', 'en-US')).toBe('Screenshot analysis');
  });

  it('bounds generated titles and removes markdown noise', () => {
    const title = summarizeConversationTitle('### ```' + 'x'.repeat(100) + '```', 'en-US');
    expect(Array.from(title).length).toBe(48);
    expect(title.endsWith('…')).toBe(true);
  });

  it('accepts bounded attachment drafts and rejects malformed or oversized data', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(isAttachmentPayloadList([{ id: 'one', name: 'image.png', mimeType: 'image/png', size: data.byteLength, data }])).toBe(true);
    expect(isAttachmentPayloadList([{ id: 'one', name: '../secret', mimeType: 'text/plain', size: data.byteLength, data }])).toBe(false);
    expect(isAttachmentPayloadList([{ id: 'one', name: 'image.png', mimeType: 'image/png', size: data.byteLength + 1, data }])).toBe(false);
    expect(isAttachmentPayloadList(Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: `${index}.txt`, mimeType: 'text/plain', size: 1, data: new Uint8Array([1]) })))).toBe(false);
  });
});
