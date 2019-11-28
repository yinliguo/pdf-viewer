import {
    EVENTS,
    PVEventHandler,
    PVHighlightClickEvent,
    PVLoadEvent,
    PVPageChangeEvent,
    PVPageResizeEvent, PVScrollEvent
} from "./event";
import {getViewSize, PDFPage} from "./page";
import {getEventPath} from "./dom";
import {animate, Animation} from "./animtion";
import {isDef, isUndef} from "./utils";
import {Log, LOG_LEVEL} from "./log";
import "./style.scss";

const pkg = require('../package.json');
export const pdfjs = require('pdfjs-dist/build/pdf.js');
// @ts-ignore
if (IS_DEV) {
    const PdfjsWorker = require('worker-loader!pdfjs-dist/build/pdf.worker.js');
    pdfjs.GlobalWorkerOptions.workerPort = new PdfjsWorker();
}

const PAGE_GAP = 10;
const DPR = window.devicePixelRatio || 1;
const CLASS_NAME = 'pdf-viewer-666';

type Options = {
    container?: HTMLElement
    url?: string
    data?: [Uint8Array]
    file?: File
    cmaps?: string
    gap?: number
    isRenderText?: boolean
    logTitle?: string
    containerBackground?: string
    borderStyle?: string
    debug?: boolean
}

export class PDFViewer {
    static version = pkg.version;
    private elem: HTMLDivElement | null;
    private isRenderText: boolean = false;

    private pdfTask = null;
    private dc = null;

    private pages: Array<PDFPage> = [];
    private width: number;
    private firstPageOriginWidth: number = 0;
    private firstPageOriginHeight: number = 0;
    private currentPage: number = 0;
    private totalPages: number = 0;

    private eventHandler: PVEventHandler;

    private renderTimer = null;
    private scrollAnimation: Animation = null;

    private ready: boolean = false;
    // 在container中插入一个辅助元素，用来正确获取页面的宽度（因为滚动条的原因）(离线无效)
    private pageHelper: HTMLElement = document.createElement('div');

    private readonly log: Log;
    private readonly debug: boolean;
    private destroyed = false;

    constructor(options: Options) {
        this.isRenderText = isDef(options.isRenderText) ? options.isRenderText : false;
        this.width = options.container ? options.container.clientWidth : 0;
        const offline = isUndef(options.container);
        this.debug = isDef(options.debug) ? options.debug : false;

        this.log = new Log(options.logTitle || '', this.debug ? LOG_LEVEL.INFO : LOG_LEVEL.WARN, this.debug);
        this.eventHandler = new PVEventHandler(this.log);

        if (!offline) {
            this.elem = document.createElement('div');
            this.elem.className = CLASS_NAME;
            this.elem.style.background = isDef(options.containerBackground) ? options.containerBackground : '#808080';
            this.elem.style.border = isDef(options.borderStyle) ? options.borderStyle : 'none';
            this.elem.style.overflow = 'auto';
            this.elem.style.padding = `0 ${isDef(options.gap) ? options.gap : 10}px`;
            this.elem.appendChild(this.pageHelper);
            this.elem.addEventListener('scroll', onscroll);
            this.elem.addEventListener('click', onclick);
            options.container.appendChild(this.elem);
            this.elem['pv'] = this;
        }

        let cfg = {
            cMapUrl: options.cmaps,
            cMapPacked: true,
        };
        if (isDef(options.url)) {
            cfg['url'] = options.url;
            this._getDocument(cfg);
        } else if (isDef(options.data)) {
            cfg['data'] = options.data;
            this._getDocument(cfg);
        } else if (isDef(options.file)) {
            if (!(options.file instanceof File)) {
                this.log.error('Invalid param "file"');
            }
            const fr = new FileReader();
            fr.readAsArrayBuffer(options.file);
            fr.onload = () => {
                // @ts-ignore
                cfg['data'] = new Uint8Array(fr.result);
                this._getDocument(cfg);
            };
            fr.onerror = () => {
                this.log.error('The param "file" cannot be loaded');
            }
        } else {
            this.log.error('You must specify the pdf source by "url", "data" or "file"');
        }
    }

    private _handlePageResize(ps) {
        this.eventHandler.trigger(EVENTS.PAGE_RESIZE, new PVPageResizeEvent(this, ps));
    }

    private _render(force: boolean = false) {
        if (!this.ready || !this.elem || this.pages.length === 0) {
            return;
        }
        const vh = this.elem.clientHeight;
        const scrollTop = this.elem.scrollTop;
        let currentPage = 0;
        let currentPageVisibleHeight = 0;
        let prevPageHeight = 0;
        this.pages.forEach((page, pageIdx) => {
            const pageElem = page.getPageElement();
            const pageHeight = pageElem.clientHeight;
            const tmpPageTop = scrollTop - prevPageHeight;
            const tmpGap = pageIdx === 0 ? 0 : PAGE_GAP;// 加上页面的margin-top，这个margin很少变动，所以写死
            if (tmpPageTop < vh + 5 * pageHeight && tmpPageTop > -vh - 5 * pageHeight) {
                // 页面顶部在可视上下浮动5个页面高度的范围内都渲染
                page.render(this.dc, force);
                // 哪个页面在container中占的空间大就使用哪个页面作为当前页面，如果相同，页码小优先
                let tmpCurrentPage = 0;
                let tmpCurrentPageVisibleHeight = 0;
                if (prevPageHeight >= scrollTop && prevPageHeight < scrollTop + vh) {
                    tmpCurrentPage = pageIdx + 1;
                    tmpCurrentPageVisibleHeight = pageHeight + tmpGap - Math.max(prevPageHeight + pageHeight - scrollTop - vh, 0);
                } else if (prevPageHeight + pageHeight + tmpGap > scrollTop && prevPageHeight + pageHeight + tmpGap <= scrollTop + vh) {
                    tmpCurrentPage = pageIdx + 1;
                    tmpCurrentPageVisibleHeight = pageHeight + tmpGap - Math.max(scrollTop - prevPageHeight, 0);
                } else if (prevPageHeight <= scrollTop && prevPageHeight + pageHeight + tmpGap >= scrollTop + vh) {
                    tmpCurrentPage = pageIdx + 1;
                    tmpCurrentPageVisibleHeight = vh;
                }
                if (tmpCurrentPage > 0 && tmpCurrentPageVisibleHeight > currentPageVisibleHeight) {
                    currentPage = tmpCurrentPage;
                    currentPageVisibleHeight = tmpCurrentPageVisibleHeight;
                }
            } else {
                page.revoke();
            }
            prevPageHeight += pageHeight + tmpGap;
        });
        if (currentPage !== this.currentPage) {
            this.currentPage = currentPage;
            this.eventHandler.trigger(EVENTS.PAGE_CHANGE, new PVPageChangeEvent(this, this.currentPage, this.totalPages));
        }
    }

    private _getDocument(cfg) {
        this.pdfTask = pdfjs.getDocument(cfg);
        this.log.mark('getdoc');
        this.pdfTask.promise.then((dc) => {
            this.log.measure('getdoc', 'get document');
            this.log.removeMark('getdoc');
            this.dc = dc;
            const numPages = this.dc.numPages;
            this.totalPages = numPages;
            if (numPages === 0) {
                this.ready = true;
                return;
            }
            if (!this.elem) {
                this.eventHandler.trigger(EVENTS.LOAD, new PVLoadEvent(this));
                return;
            }
            /* choose the first page size as initial size for all pages */
            this.dc.getPage(1)
                .then((page) => {
                    const vp = page.getViewport({});
                    this.firstPageOriginWidth = vp.viewBox[2];
                    this.firstPageOriginHeight = vp.viewBox[3];
                    for (let i = 1; i <= numPages; i++) {
                        const p = new PDFPage({
                            pdfjs,
                            pageNum: i,
                            pdfPage: i === 1 ? page : null,
                            width: this.width,
                            height: this.width * this.firstPageOriginHeight / this.firstPageOriginWidth,
                            isRenderText: this.isRenderText,
                            pageResizeCallback: this._handlePageResize.bind(this),
                            log: this.log
                        });
                        this.pages.push(p);
                        this.elem.appendChild(p.getPageElement());
                    }
                    this.ready = true;
                })
                .then(() => {
                    // 再次调用then方法是为了延迟渲染的执行，以便上面的页面元素都插入到container中，并且样式得到正确应用
                    // 因为可能产生滚动条，所以重置页面尺寸
                    this.width = this.pageHelper.clientWidth;
                    const height = this.width / this.firstPageOriginWidth * this.firstPageOriginHeight;
                    const pageSizes = {};
                    this.pages.forEach((p, pi) => {
                        p.resize(this.width);
                        pageSizes[pi + 1] = {
                            w: this.width,
                            h: height
                        };
                    });
                    Promise.resolve()
                        .then(() => {
                            this.eventHandler.trigger(EVENTS.LOAD, new PVLoadEvent(this));
                        })
                        .then(() => {
                            this.eventHandler.trigger(EVENTS.PAGE_RESIZE, new PVPageResizeEvent(this, pageSizes));
                        })
                        .then(() => {
                            this._render();
                        });
                });
        });
    }

    addEventListener(name: string, handler: Function): PDFViewer {
        this.eventHandler.addHandler(name, handler);
        return this;
    }

    removeEventListener(eventName: string, handler: Function): PDFViewer {
        this.eventHandler.removeHandler(eventName, handler);
        return this;
    }

    getPDFInfo() {
        return {
            // 总页数
            totalPages: this.totalPages,
            // 页面间距
            pageGap: PAGE_GAP
        };
    }

    scrollTo(page: number, pageTop: number, cb: Function = null): PDFViewer {
        if (!this.ready || !this.elem) {
            return this;
        }
        if (page < 1 || page > this.pages.length) {
            return this;
        }
        if (this.scrollAnimation) {
            this.scrollAnimation.stop();
            this.scrollAnimation = null;
        }
        const pageInstance = this.pages[page - 1];
        const pageElement = pageInstance.getPageElement();
        const scrollTop = pageElement.offsetTop + pageInstance.calcSize(pageTop) - this.elem.offsetHeight / 2;
        this.scrollAnimation = animate(this.elem.scrollTop, scrollTop, 300, (v) => {
            this.elem.scrollTop = v;
        }, cb);
        return this;
    }

    highlight(page: number, x: number, y: number, w: number, h: number, highlightClass: string = 'pdf-highlight'): symbol {
        if (!this.ready) {
            return null;
        }
        if (page < 1 || page > this.pages.length) {
            return null;
        }
        return this.pages[page - 1].highlight(x, y, w, h, highlightClass);
    }

    removeHighlight(page: number, id: symbol): PDFViewer {
        if (!this.elem) {
            return this;
        }
        if (page >= 1) {
            if (page > this.pages.length) {
                return this;
            }
            if (id !== undefined) {
                this.pages[page - 1].removeHighlight(id);
            } else {
                this.pages[page - 1].removeAllHighlights();
            }
        } else {
            this.pages.forEach((p) => {
                p.removeAllHighlights();
            });
        }
        return this;
    }

    highlightFocus(page: number, id: symbol, highlightFocusClass = 'pdf-highlight-focus'): PDFViewer {
        if (!this.ready || !this.elem) {
            return this;
        }
        if (page >= 1 && page <= this.pages.length) {
            this.pages[page - 1].highlightFocus(id, highlightFocusClass);
        }
        return this;
    }

    highlightBlur(page: number, id: symbol): PDFViewer {
        if (!this.ready || !this.elem) {
            return this;
        }
        if (page >= 1 && page <= this.pages.length) {
            this.pages[page - 1].highlightBlur(id);
        }
        return this;
    }

    renderPage(page: number, width: number, cb: (canvas: HTMLCanvasElement) => void, devicePixelCompatible = true) {
        this.pdfTask.promise.then((dc) => {
            // @ts-ignore
            dc.getPage(page).then((pdfPage: PDFPageProxy) => {
                width = (width || this.width) * (devicePixelCompatible ? DPR : 1);
                const viewport = pdfPage.getViewport();
                const vs = getViewSize(viewport);
                const scale = width / vs.w;
                const height = scale * vs.h;
                const vp = pdfPage.getViewport({scale,});
                /* render canvas layer */
                const canvas = document.createElement('canvas');
                const canvasCtx = canvas.getContext('2d');
                canvas.width = width;
                canvas.height = height;
                const canvasRenderTask = pdfPage.render({
                    canvasContext: canvasCtx,
                    viewport: vp,
                });
                canvasRenderTask.promise.then(() => {
                    cb(canvas);
                });
            });
        });
    }

    resize(width?: number): PDFViewer {
        if (this.firstPageOriginWidth === 0 || !this.elem) {
            return this;
        }
        if (isUndef(width)) {
            width = this.elem.parentElement.clientWidth;
        }
        this.elem.style.width = `${width}px`;
        Promise.resolve().then(() => {
            const tmpWidth = this.pageHelper.clientWidth;
            if (this.width !== tmpWidth) {
                this.width = tmpWidth;
                const pageSizes = {};
                this.pages.forEach((p, i) => {
                    p.resize(this.width);
                    pageSizes[i + 1] = {
                        w: tmpWidth,
                        h: p.getHeight()
                    };
                });
                this._render(true);
                this.eventHandler.trigger(EVENTS.PAGE_RESIZE, new PVPageResizeEvent(this, pageSizes));
            }
        });
        return this;
    }

    destroy() {
        this.destroyed = true;
        if (this.renderTimer) {
            clearTimeout(this.renderTimer);
        }
        // 销毁页面
        this.pages.forEach((page) => {
            page.destroy();
        });
        this.pages = null;
        // 销毁viewer element
        if (this.elem) {
            this.pageHelper.remove();
            this.pageHelper = null;
            this.elem.removeEventListener('scroll', onscroll);
            this.elem.removeEventListener('click', onclick);
            this.elem.remove();
            this.elem = null;
        }
        // 销毁event handler
        this.eventHandler = null;
        // 销毁pdf.js相关的变量
        this.dc.destroy();
        this.dc = null;
        this.pdfTask = null;
    }
}

function onclick(e) {
    const eventPath = getEventPath(e);
    const pvElem = eventPath.filter((item: HTMLElement) => {
        return item.className === CLASS_NAME;
    })[0];
    if (!pvElem) {
        return;
    }
    const pv = pvElem['pv'];
    if (!pv.eventHandler.hasListener(EVENTS.HIGHLIGHT_CLICK)) {
        return;
    }
    if (eventPath.some((elem) => elem instanceof HTMLElement && elem.hasAttribute('data-page'))) {
        let x = e.offsetX;
        let y = e.offsetY;
        let page = 0;
        for (let i = 0; i < eventPath.length; i++) {
            const elem = eventPath[i];
            if (elem instanceof HTMLElement && elem.hasAttribute('data-page')) {
                page = +elem.getAttribute('data-page');
                break;
            } else {
                x += elem.offsetLeft;
                y += elem.offsetTop;
            }
        }
        const highlights = pv.pages[page - 1].getHighlightsByPoint(x, y);
        if (highlights.length > 0) {
            pv.eventHandler.trigger(EVENTS.HIGHLIGHT_CLICK, new PVHighlightClickEvent(pv, highlights));
        }
    }
}

function onscroll(e: Event) {
    const pvElem = e.target;
    const pv = pvElem['pv'];
    if (pv.renderTimer) {
        clearTimeout(pv.renderTimer);
        pv.renderTimer = null;
    }
    pv.renderTimer = setTimeout(() => {
        pv._render();
    }, 100);
    pv.eventHandler.trigger(EVENTS.SCROLL, new PVScrollEvent(pv, pvElem['scrollTop'], pvElem['scrollLeft']));
}
