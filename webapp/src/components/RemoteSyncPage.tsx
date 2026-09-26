import { useEffect, useState } from 'preact/hooks';
import { Clock, Globe2, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-preact';
import ConfirmDialog from '@/components/ConfirmDialog';
import LoadingState from '@/components/LoadingState';
import { createAuthedFetch } from '@/lib/api/auth';
import {
  type RemoteSyncSourceRecord,
  createRemoteSyncSource,
  deleteRemoteSyncSource,
  listRemoteSyncSources,
  triggerRemoteSyncSource,
  updateRemoteSyncSource,
} from '@/lib/api/remote-sync';
import { t } from '@/lib/i18n';
import type { SessionState } from '@/lib/types';

interface RemoteSyncPageProps {
  session: SessionState | null;
  onNotify: (type: 'success' | 'error' | 'warning', text: string) => void;
}

function formatSyncTime(value: string | null): string {
  if (!value) return t('txt_never');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('txt_never');
  return date.toLocaleString();
}

function statusLabel(source: RemoteSyncSourceRecord): string {
  if (source.status === 'syncing') return t('txt_remote_sync_status_syncing');
  if (source.status === 'error') return t('txt_remote_sync_status_error');
  if (source.status === 'ok') return t('txt_remote_sync_status_ok');
  return t('txt_remote_sync_status_idle');
}

export default function RemoteSyncPage(props: RemoteSyncPageProps): JSX.Element {
  const authedFetch = createAuthedFetch(() => props.session, () => {});
  const [sources, setSources] = useState<RemoteSyncSourceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');
  const [masterPassword, setMasterPassword] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addResult, setAddResult] = useState<{ ok: boolean; added: number; updated: number; warnings: string[]; error: string | null } | null>(null);

  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      setSources(await listRemoteSyncSources(authedFetch));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAdd(event: Event): Promise<void> {
    event.preventDefault();
    setAddError(null);
    setAddResult(null);
    if (!url.trim() || !email.trim() || !masterPassword) {
      setAddError(t('txt_remote_sync_form_required'));
      return;
    }
    setAdding(true);
    try {
      const created = await createRemoteSyncSource(authedFetch, {
        url: url.trim(),
        email: email.trim(),
        masterPassword,
        syncIntervalMinutes: Math.max(1, Math.round(Number(intervalMinutes) || 60)),
      });
      setAddResult({
        ok: created.syncResult?.ok ?? false,
        added: created.syncResult?.added ?? 0,
        updated: created.syncResult?.updated ?? 0,
        warnings: created.syncResult?.warnings ?? [],
        error: created.syncResult?.error ?? null,
      });
      setUrl('');
      setEmail('');
      setMasterPassword('');
      await load();
      if (created.syncResult?.ok) {
        props.onNotify('success', t('txt_remote_sync_added'));
      } else {
        props.onNotify('warning', t('txt_remote_sync_added_with_error'));
      }
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    } finally {
      setAdding(false);
    }
  }

  async function handleTrigger(source: RemoteSyncSourceRecord): Promise<void> {
    setSyncingId(source.id);
    try {
      const result = await triggerRemoteSyncSource(authedFetch, source.id);
      if (result.syncResult?.ok) {
        props.onNotify('success', t('txt_remote_sync_synced'));
      } else {
        props.onNotify('error', result.syncResult?.error || t('txt_remote_sync_sync_failed'));
      }
      await load();
    } catch (error) {
      props.onNotify('error', error instanceof Error ? error.message : String(error));
    } finally {
      setSyncingId(null);
    }
  }

  async function handleToggleEnabled(source: RemoteSyncSourceRecord): Promise<void> {
    try {
      await updateRemoteSyncSource(authedFetch, source.id, { enabled: !source.enabled });
      await load();
    } catch (error) {
      props.onNotify('error', error instanceof Error ? error.message : String(error));
    }
  }

  async function handleDelete(): Promise<void> {
    if (!deleteId) return;
    setDeleteBusy(true);
    try {
      await deleteRemoteSyncSource(authedFetch, deleteId);
      setDeleteId(null);
      props.onNotify('success', t('txt_remote_sync_deleted'));
      await load();
    } catch (error) {
      props.onNotify('error', error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="section-head">
          <h3>{t('nav_remote_sync')}</h3>
        </div>
        <p className="muted-inline">
          {t('txt_remote_sync_help_intro')}
        </p>
        <p className="muted-inline">
          {t('txt_remote_sync_help_key')}
        </p>
      </section>

      <section className="card">
        <div className="section-head">
          <h3>{t('txt_remote_sync_add_source')}</h3>
        </div>
        <form onSubmit={(event) => void handleAdd(event)} className="stack">
          <label className="field-label" htmlFor="remote-sync-url">{t('txt_remote_sync_url')}</label>
          <input
            id="remote-sync-url"
            type="url"
            className="field-input"
            placeholder="https://vault.example.com"
            value={url}
            onChange={(event) => setUrl((event.target as HTMLInputElement).value)}
            autoComplete="off"
          />
          <label className="field-label" htmlFor="remote-sync-email">{t('txt_remote_sync_email')}</label>
          <input
            id="remote-sync-email"
            type="email"
            className="field-input"
            placeholder="user@example.com"
            value={email}
            onChange={(event) => setEmail((event.target as HTMLInputElement).value)}
            autoComplete="off"
          />
          <label className="field-label" htmlFor="remote-sync-master-password">{t('txt_remote_sync_master_password')}</label>
          <input
            id="remote-sync-master-password"
            type="password"
            className="field-input"
            value={masterPassword}
            onChange={(event) => setMasterPassword((event.target as HTMLInputElement).value)}
            autoComplete="new-password"
          />
          <label className="field-label" htmlFor="remote-sync-interval">{t('txt_remote_sync_interval')}</label>
          <input
            id="remote-sync-interval"
            type="number"
            className="field-input"
            min={1}
            max={10080}
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(Number((event.target as HTMLInputElement).value))}
          />
          {!!addError && <div className="local-error">{addError}</div>}
          {!!addResult && (
            <div className={`local-note ${addResult.ok ? 'local-note-success' : 'local-note-warn'}`}>
              {addResult.ok
                ? t('txt_remote_sync_result_ok', { added: String(addResult.added), updated: String(addResult.updated) })
                : t('txt_remote_sync_result_error', { error: addResult.error || '' })}
              {addResult.warnings.map((warning) => (
                <div key={warning} className="muted-inline">{warning}</div>
              ))}
            </div>
          )}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={adding}>
              <Plus size={14} className="btn-icon" />
              {adding ? t('txt_remote_sync_adding') : t('txt_remote_sync_add')}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="section-head">
          <h3>{t('txt_remote_sync_sources')}</h3>
          <div className="actions">
            <button type="button" className="btn btn-secondary small" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className="btn-icon" />
              {t('txt_refresh')}
            </button>
          </div>
        </div>

        {loading && !sources.length && <LoadingState lines={3} compact />}
        {!loading && loadError && <div className="local-error">{loadError}</div>}
        {!loading && !loadError && sources.length === 0 && (
          <div className="empty empty-comfortable">{t('txt_remote_sync_no_sources')}</div>
        )}

        {sources.map((source) => {
          const last = source.lastResult;
          const isSyncing = syncingId === source.id || source.status === 'syncing';
          return (
            <div key={source.id} className="remote-sync-row">
              <div className="remote-sync-row-main">
                <div className="remote-sync-row-title">
                  <Globe2 size={14} className="remote-sync-row-icon" />
                  <strong>{source.url.replace(/^https?:\/\//i, '')}</strong>
                  <span className={`remote-sync-status remote-sync-status-${source.status}`}>{statusLabel(source)}</span>
                </div>
                <small className="muted-inline">{source.email}</small>
                <small className="muted-inline">
                  <Clock size={12} className="btn-icon" />
                  {t('txt_remote_sync_every_minutes', { minutes: String(source.syncIntervalMinutes) })}
                  {' · '}
                  {t('txt_remote_sync_last_sync', { time: formatSyncTime(source.lastSyncAt) })}
                </small>
                {source.status === 'ok' && !!last && (
                  <small className="muted-inline">
                    {t('txt_remote_sync_stats', {
                      added: String(last.added ?? 0),
                      updated: String(last.updated ?? 0),
                      folders: String(last.folders ?? 0),
                    })}
                  </small>
                )}
                {source.status === 'error' && !!last?.error && (
                  <div className="local-error">{last.error}</div>
                )}
                {!!last?.warnings && last.warnings.length > 0 && source.status === 'ok' && (
                  <div className="local-note local-note-warn">
                    <ShieldAlert size={13} className="btn-icon" />
                    {last.warnings.map((warning) => (
                      <div key={warning} className="muted-inline">{warning}</div>
                    ))}
                  </div>
                )}
              </div>
              <div className="actions remote-sync-actions">
                <button
                  type="button"
                  className="btn btn-secondary small"
                  disabled={isSyncing}
                  onClick={() => void handleTrigger(source)}
                >
                  <RefreshCw size={13} className="btn-icon" />
                  {isSyncing ? t('txt_remote_sync_syncing') : t('txt_remote_sync_sync_now')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary small"
                  onClick={() => void handleToggleEnabled(source)}
                >
                  {source.enabled ? t('txt_remote_sync_disable') : t('txt_remote_sync_enable')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger small"
                  onClick={() => setDeleteId(source.id)}
                >
                  <Trash2 size={13} className="btn-icon" />
                  {t('txt_delete')}
                </button>
              </div>
            </div>
          );
        })}
      </section>

      {!!deleteId && (
        <ConfirmDialog
          title={t('txt_remote_sync_delete_confirm_title')}
          confirmLabel={t('txt_delete')}
          busy={deleteBusy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteId(null)}
        >
          {t('txt_remote_sync_delete_confirm_body')}
        </ConfirmDialog>
      )}
    </div>
  );
}
