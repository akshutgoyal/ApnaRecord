import React from 'react';

/**
 * A boundary around one panel, not around the page.
 *
 * The point is blast radius. Reading a contract means several independent calls —
 * logs, blocks, timestamp lookups — and any one of them can fail while the rest
 * succeed. Without a boundary, one flaky `eth_getLogs` blanks an entire
 * dashboard; with one, a single card says it could not load and everything else
 * stays useful.
 */
export default class PanelBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Deliberately a console warning, not a thrown error: the panel failing is
    // the event we are handling.
    console.error(`[PanelBoundary] ${this.props.name || 'panel'} failed:`, error, info);
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    const { children, name = 'This panel', hint } = this.props;

    if (!error) return children;

    return (
      <div className="rounded-xl border border-error-200 bg-error-50 px-4 py-4">
        <div className="flex items-start gap-2.5">
          <span aria-hidden="true" className="mt-px shrink-0 text-xs font-bold text-error-700">
            ✕
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-error-700">{name} could not be loaded</p>
            <p className="mt-1 text-[11px] leading-relaxed text-error-700/85">
              {hint || 'The rest of the page is unaffected — this is usually one failed RPC call.'}
            </p>
            <p className="mono mt-2 break-words text-[10px] text-error-700/70">
              {String(error?.message || error)}
            </p>
            <button type="button" onClick={this.reset} className="btn-secondary mt-2.5">
              Retry this panel
            </button>
          </div>
        </div>
      </div>
    );
  }
}
