import { useCallback, useState } from 'preact/hooks';
import { CheckCircle2, Download, Info, RefreshCw } from 'lucide-preact';
import { t } from '@/lib/i18n';
import { checkUpdate, applyUpdate } from '@/lib/api/update';
import { createAuthedFetch } from '@/lib/api/auth';
import LoadingState from '@/components/LoadingState';
import type { SessionInfo } from '@/lib/api/session';

interface Props {
  session: SessionInfo;
  onNotify: (kind: 'success' | 'error' | 'warning', message: string) => void;
}

export default function UpdatePage({ session, onNotify }: Props) {
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof checkUpdate>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const authedFetch = useCallback(createAuthedFetch(() => session, () => {}), [session]);

  async function doCheck(): Promise<void> {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const data = await checkUpdate(authedFetch);
      setInfo(data);
      if (!data.hasUpdate) {
        setResult(t('txt_update_up_to_date', { version: data.currentVersion }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  async function doApply(): Promise<void> {
    if (!info) return;
    setApplying(true);
    setError(null);
    try {
      const outcome = await applyUpdate(authedFetch);
      setResult(outcome.message);
      onNotify('success', t('txt_update_applying'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onNotify('error', msg);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="section-head">
          <h3>{t('txt_update_title')}</h3>
          <div className="actions">
            <button type="button" className="btn btn-secondary small" onClick={() => void doCheck()} disabled={checking}>
              <RefreshCw size={14} className="btn-icon" />
              {checking ? t('txt_update_checking') : t('txt_update_check')}
            </button>
          </div>
        </div>

        <p className="muted-inline">{t('txt_update_desc')}</p>
        <p className="muted-inline">
          <Info size={13} className="btn-icon" />
          {t('txt_update_source', { source: 'github.com/guimoyun/nodewarden-WL/releases' })}
        </p>

        {!!error && <div className="local-error">{error}</div>}
        {!!result && <div className="local-note local-note-success">{result}</div>}

        {!!info && !error && (
          <div className="info-grid">
            <div><span className="muted-inline">{t('txt_update_current')}</span><br /><strong>{info.currentVersion}</strong></div>
            <div><span className="muted-inline">{t('txt_update_latest')}</span><br /><strong>{info.latestVersion || '—'}</strong></div>
            <div><span className="muted-inline">{t('txt_update_platform')}</span><br /><strong>{info.platform}</strong></div>
            {info.hasUpdate && !!info.assetName && (
              <div><span className="muted-inline">{t('txt_update_package')}</span><br /><strong>{info.assetName}</strong></div>
            )}
            {info.hasUpdate && !!info.releaseNotes && (
              <div><span className="muted-inline">{t('txt_update_notes')}</span><br /><small style="white-space:pre-wrap">{info.releaseNotes}</small></div>
            )}
          </div>
        )}

        {!!info?.hasUpdate && (
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void doApply()} disabled={applying}>
              <Download size={14} className="btn-icon" />
              {applying ? t('txt_update_applying') : t('txt_update_apply')}
            </button>
            {info.assetUrl && (
              <a className="btn btn-secondary" href={info.assetUrl} target="_blank" rel="noreferrer">
                {t('txt_update_manual')}
              </a>
            )}
          </div>
        )}

        {!info && !checking && !error && (
          <div className="empty empty-comfortable">
            <CheckCircle2 size={18} className="btn-icon" />
            {t('txt_update_hint')}
          </div>
        )}
        {checking && <LoadingState lines={2} compact />}
      </section>
    </div>
  );
}
