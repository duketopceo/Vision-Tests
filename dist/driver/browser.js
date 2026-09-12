import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug.js';
import { chromium, firefox, webkit } from 'playwright';
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_QUALITY = 70;
/**
 * One Playwright context per run. Viewport and deviceScaleFactor are pinned so
 * vision-model pixel coordinates map 1:1 to viewport pixels (KTD2).
 */
export class BrowserDriver {
    browser;
    context;
    page;
    quality;
    videoDir;
    viewport;
    browserTimeoutMs;
    video;
    closed;
    constructor(browser, context, page, quality, videoDir, viewport, browserTimeoutMs, video, closed = false) {
        this.browser = browser;
        this.context = context;
        this.page = page;
        this.quality = quality;
        this.videoDir = videoDir;
        this.viewport = viewport;
        this.browserTimeoutMs = browserTimeoutMs;
        this.video = video;
        this.closed = closed;
    }
    static async launch(options = {}) {
        const viewport = options.viewport ?? DEFAULT_VIEWPORT;
        const videoDir = options.videoDir ?? (await mkdtemp(join(tmpdir(), 'argus-video-')));
        await mkdir(videoDir, { recursive: true });
        const browserName = options.browser ?? 'chromium';
        const browserType = { chromium, firefox, webkit }[browserName];
        if (browserType === undefined) {
            throw new Error(`unknown browser: ${browserName}`);
        }
        const browser = await browserType.launch({ headless: true });
        try {
            const context = await browser.newContext({
                viewport,
                deviceScaleFactor: 1,
                recordVideo: { dir: videoDir, size: viewport },
            });
            const page = await context.newPage();
            return new BrowserDriver(browser, context, page, options.screenshotQuality ?? DEFAULT_QUALITY, videoDir, viewport, options.browserTimeoutMs ?? 30_000, undefined);
        }
        catch (e) {
            await browser.close().catch(() => undefined);
            throw e;
        }
    }
    get rawPage() {
        return this.page;
    }
    get recordingDir() {
        return this.videoDir;
    }
    async goto(url) {
        await this.page.goto(url, { waitUntil: 'load' });
    }
    /**
     * Capture the current observation: a bounded JPEG screenshot plus the page's
     * a11y tree as YAML via ariaSnapshot (not the deprecated accessibility API).
     *
     * `grid: true` paints a temporary coordinate overlay (lines + axis labels
     * every 100px) before the screenshot and removes it immediately after — the
     * set-of-marks trick that measurably improves vision-model pixel grounding.
     */
    async observe(options = {}) {
        const grid = options.grid === true;
        if (grid)
            await this._paintGrid();
        try {
            const screenshotJpeg = await this.page.screenshot({
                type: 'jpeg',
                quality: this.quality,
                scale: 'css',
            });
            const a11yYaml = await this.page.locator('body').ariaSnapshot();
            return { screenshotJpeg, a11yYaml, width: this.viewport.width, height: this.viewport.height };
        }
        finally {
            if (grid)
                await this._removeGrid();
        }
    }
    async _paintGrid() {
        await this.page.evaluate(() => {
            const doc = globalThis.document;
            const overlay = doc.createElement('div');
            overlay.id = '__argus_grid';
            overlay.setAttribute('aria-hidden', 'true');
            overlay.style.cssText =
                'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
                    'background-image:' +
                    'linear-gradient(to right, rgba(255,0,0,.35) 1px, transparent 1px),' +
                    'linear-gradient(to bottom, rgba(255,0,0,.35) 1px, transparent 1px);' +
                    'background-size:100px 100px;';
            doc.body.appendChild(overlay);
            const labels = doc.createElement('div');
            labels.id = '__argus_grid_labels';
            labels.setAttribute('aria-hidden', 'true');
            labels.style.cssText =
                'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
                    'font:9px monospace;color:rgba(200,0,0,.9);';
            const win = globalThis;
            for (let x = 100; x < win.innerWidth; x += 100) {
                for (let y = 100; y < win.innerHeight; y += 100) {
                    const tag = win.document.createElement('span');
                    tag.style.cssText = `position:absolute;left:${x + 1}px;top:${y + 1}px;`;
                    tag.textContent = `${x},${y}`;
                    labels.appendChild(tag);
                }
            }
            doc.body.appendChild(labels);
        });
    }
    async _removeGrid() {
        await this.page
            .evaluate(() => {
            const doc = globalThis.document;
            for (const id of ['__argus_grid', '__argus_grid_labels']) {
                doc.getElementById(id)?.remove();
            }
        })
            .catch(() => undefined);
    }
    /** Path of the recorded webm, available after close(). */
    videoPath() {
        return this.video;
    }
    /** Close the context and browser; resolves the video artifact path. Idempotent. */
    async close() {
        if (this.closed)
            return this.video;
        this.closed = true;
        const video = this.page.video();
        try {
            await this._withTimeout(this.context.close());
        }
        catch (e) {
            debug('browser', `context close failed: ${e.message}`);
        }
        if (video) {
            try {
                this.video = await this._withTimeout(video.path());
            }
            catch {
                this.video = undefined;
            }
        }
        try {
            await this._withTimeout(this.browser.close());
        }
        catch (e) {
            debug('browser', `browser close failed: ${e.message}`);
        }
        return this.video;
    }
    _withTimeout(promise) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('browser cleanup timed out')), this.browserTimeoutMs)),
        ]);
    }
}
