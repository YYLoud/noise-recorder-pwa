import type { AppSettings, NoiseEvent, RecordingSession } from '../types.ts';
import {
  formatBytes,
  formatDateOnly,
  formatDateTimeShort,
  formatDuration,
  formatTimeWithMs,
} from '../utils/format.ts';

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class ReportExporter {
  public static exportCSV(events: NoiseEvent[], sessions: RecordingSession[]): void {
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    const header = [
      '事件序號',
      '發生日期',
      '精確時間(含毫秒)',
      '拍攝位置標籤',
      '錄影模式',
      '最大分貝(dB)',
      '背景基準(dB)',
      '瞬間突增(+dB)',
      '持續時間(秒)',
      '對應影片編號',
      '影片時間點(秒)',
      '備註',
    ];

    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const rows = sorted.map((evt, idx) => {
      const session = sessionMap.get(evt.sessionId);
      const modeText = session?.mode === 'event' ? '事件觸發擷取' : '全程連續錄影';
      return [
        idx + 1,
        formatDateOnly(evt.timestamp),
        formatTimeWithMs(evt.timestamp),
        evt.locationLabel,
        modeText,
        evt.peakDb.toFixed(1),
        evt.baselineDb.toFixed(1),
        `+${evt.deltaDb.toFixed(1)}`,
        (evt.durationMs / 1000).toFixed(2),
        evt.sessionId,
        evt.videoOffsetSec.toFixed(2),
        evt.note,
      ].map(escapeCsvCell).join(',');
    });

    const csvContent = '\uFEFF' + [header.join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const dateTag = formatDateOnly(Date.now());
    triggerDownload(blob, `噪音記錄器_蒐證報表_${dateTag}.csv`);
  }

  public static exportJSON(events: NoiseEvent[], sessions: RecordingSession[]): void {
    const payload = {
      appName: '噪音記錄器',
      exportedAt: new Date().toISOString(),
      summary: {
        totalSessions: sessions.length,
        totalEvents: events.length,
        highestPeakDb: events.reduce((max, e) => Math.max(max, e.peakDb), 0),
      },
      sessions: sessions.map((s) => ({
        id: s.id,
        mode: s.mode,
        startTimeIso: new Date(s.startTime).toISOString(),
        endTimeIso: new Date(s.endTime).toISOString(),
        durationSec: Number(s.durationSec.toFixed(2)),
        mimeType: s.mimeType,
        fileSizeBytes: s.fileSize,
        resolution: s.resolution,
        fps: s.fps,
        locationLabel: s.locationLabel,
        eventCount: s.eventCount,
        peakDb: s.peakDb,
      })),
      events: [...events]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((e, idx) => ({
          index: idx + 1,
          id: e.id,
          sessionId: e.sessionId,
          timestampIso: new Date(e.timestamp).toISOString(),
          localTimestamp: `${formatDateOnly(e.timestamp)} ${formatTimeWithMs(e.timestamp)}`,
          durationMs: e.durationMs,
          peakDb: e.peakDb,
          baselineDb: e.baselineDb,
          deltaDb: e.deltaDb,
          videoOffsetSec: e.videoOffsetSec,
          locationLabel: e.locationLabel,
          note: e.note,
        })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
    const dateTag = formatDateOnly(Date.now());
    triggerDownload(blob, `噪音記錄器_蒐證資料_${dateTag}.json`);
  }

  public static buildPrintableReportHtml(
    events: NoiseEvent[],
    sessions: RecordingSession[],
    settings: AppSettings,
  ): string {
    const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const highestPeak = sortedEvents.reduce((max, e) => Math.max(max, e.peakDb), 0);
    const maxDelta = sortedEvents.reduce((max, e) => Math.max(max, e.deltaDb), 0);
    const totalBytes = sessions.reduce((acc, s) => acc + s.fileSize, 0);
    const totalDurationSec = sessions.reduce((acc, s) => acc + s.durationSec, 0);
    const generatedAt = formatDateTimeShort(Date.now());

    const rowsHtml = sortedEvents.length === 0
      ? `<tr><td colspan="6" class="report-empty">尚無偵測到的突發巨響事件。請先進行蒐證錄影或觸發測試。</td></tr>`
      : sortedEvents
          .map((evt, index) => {
            const imgHtml = evt.snapshotDataUrl
              ? `<img src="${evt.snapshotDataUrl}" alt="事件 #${index + 1} 浮水印截圖" class="report-thumb" />`
              : '<span class="report-muted">無截圖</span>';
            return `
              <tr>
                <td class="num">#${index + 1}</td>
                <td>
                  <div class="mono-strong">${escapeHtml(formatDateOnly(evt.timestamp))}</div>
                  <div class="mono">${escapeHtml(formatTimeWithMs(evt.timestamp))}</div>
                  <div class="report-sub">${escapeHtml(evt.locationLabel)}</div>
                </td>
                <td>
                  <div class="peak-badge">${evt.peakDb.toFixed(1)} dB</div>
                  <div class="report-sub">背景 ${evt.baselineDb.toFixed(1)} dB</div>
                </td>
                <td class="delta-cell">+${evt.deltaDb.toFixed(1)} dB</td>
                <td>
                  <div>${(evt.durationMs / 1000).toFixed(2)} 秒</div>
                  <div class="report-sub">影片 ${evt.videoOffsetSec.toFixed(1)}s 處</div>
                </td>
                <td class="thumb-cell">${imgHtml}</td>
              </tr>
            `;
          })
          .join('');

    return `
      <div class="official-report-doc">
        <div class="report-doc-header">
          <div>
            <h2>噪音記錄器 — 鄰居突發噪音事件蒐證報告</h2>
            <p class="report-subtitle">Acoustic &amp; Video Synchronized Evidence Log</p>
          </div>
          <div class="report-meta-right">
            <div>產出時間：${escapeHtml(generatedAt)}</div>
            <div>蒐證地點：${escapeHtml(settings.locationLabel)}</div>
          </div>
        </div>

        <div class="report-summary-grid">
          <div class="report-stat">
            <span>累積蒐證場次</span>
            <strong>${sessions.length} 筆</strong>
          </div>
          <div class="report-stat">
            <span>累積錄影時長 / 容量</span>
            <strong>${escapeHtml(formatDuration(totalDurationSec))} / ${escapeHtml(formatBytes(totalBytes))}</strong>
          </div>
          <div class="report-stat">
            <span>突發巨響總次數</span>
            <strong>${sortedEvents.length} 次</strong>
          </div>
          <div class="report-stat">
            <span>最高峰值 / 最大突增</span>
            <strong>${highestPeak.toFixed(1)} dB / +${maxDelta.toFixed(1)} dB</strong>
          </div>
        </div>

        <div class="report-methodology">
          <strong>蒐證技術說明：</strong>本報告由「噪音記錄器」以未經語音降噪過濾之原始麥克風音訊（關閉降噪、回音消除與自動增益）搭配即時影像擷取產生，每幀畫面皆直接燒錄毫秒級系統時間、拍攝位置與即時分貝值，同時以「絕對分貝門檻 (≥${settings.thresholdDb} dB)」及「相對 5 秒環境背景基準突增 (≥+${settings.deltaThresholdDb} dB)」雙重條件認定突發關門或撞擊巨響。
        </div>

        <table class="report-table">
          <thead>
            <tr>
              <th>序號</th>
              <th>發生日期與精確時間</th>
              <th>峰值分貝</th>
              <th>瞬間突增</th>
              <th>持續與影片定位</th>
              <th>含時間浮水印瞬間截圖</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  }
}
