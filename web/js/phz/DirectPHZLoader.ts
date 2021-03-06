import {PathStr} from '../util/Strings';
import {URLStr} from '../util/Strings';
import {URLs} from '../util/URLs';
import {PHZReader} from './PHZReader';
import {Logger} from '../logger/Logger';
import {Captured} from '../capture/renderer/Captured';
import {Resources} from './Resources';
import {Reducers} from '../util/Reducers';
import {Blobs} from '../util/Blobs';
import {ResourceEntry} from './ResourceEntry';
import {Optional} from '../util/ts/Optional';
import {Latch} from '../util/Latch';
import {DOM} from '../util/DOM';

const log = Logger.create();

/**
 * Loads PHZs directly by opening them, decompressing them, and parsing the HTML
 * and then replacing the iframes directly.
 */
export class DirectPHZLoader {

    private readonly linkPromises: LinkPromise[] = [];

    constructor(private resource: PathStr | URLStr,
                private phzReader: PHZReader,
                private resources: Resources,
                private metadata: Captured | null) {

    }

    public async load(): Promise<Optional<Captured>> {

        try {

            if (this.metadata) {

                const url = this.metadata.url;

                await this.loadDocument(url, this.resources);

                return Optional.of(this.metadata);

            } else {
                log.warn("Document has no metadata: " + this.resource);
                return Optional.empty();
            }

        } finally {
            await this.phzReader.close();
        }

    }

    public async close() {
        this.phzReader.close();
    }

    private getResourceEntry(url: string): ResourceEntry | undefined {

        return Object.values(this.resources.entries)
            .filter(current => current.resource.url === url)
            .reduce(Reducers.FIRST, undefined);

    }

    private async loadDocument(url: string,
                               resources: Resources) {

        const primaryResourceEntry = this.getResourceEntry(url);

        if (primaryResourceEntry) {

            const iframe = <HTMLIFrameElement> document.getElementById('content');
            await this.loadResource(primaryResourceEntry, iframe);

            await Promise.all(this.linkPromises);

        } else {
            log.warn("No primary resource found for: " + url);
        }

    }
    public static async create(resource: PathStr | URLStr) {

        const toPHZReader = async () => {

            const phzReader = new PHZReader();

            if (URLs.isURL(resource)) {

                const response = await fetch(resource);
                const blob = await response.blob();

                await phzReader.init(blob);

            } else {
                // this is a path string.
                await phzReader.init(resource);
            }

            return phzReader;

        };

        const phzReader = await toPHZReader();
        const metadata = await phzReader.getMetadata();
        const resources = await phzReader.getResources();

        return new DirectPHZLoader(resource, phzReader, resources, metadata);

    }

    private async loadResource(resourceEntry: ResourceEntry,
                               iframe: HTMLIFrameElement) {


        const blob = await this.phzReader.getResourceAsBlob(resourceEntry);

        // now that we have the blob, which should be HTML , parse it into
        // its own document object.

        const str = await Blobs.toText(blob);

        const doc = new DOMParser().parseFromString(str, 'text/html');

        const newLinkPromises = this.createLinkPromises(doc);

        this.linkPromises.push(...newLinkPromises);

        const iframes = this.neutralizeIFrames(doc);

        DOM.removeChildNodes(iframe.contentDocument!.documentElement!);

        DOM.appendChildNodes(doc.documentElement!, iframe.contentDocument!.documentElement!);

        await this.loadIFrames(iframes);

    }

    private createLinkPromises(doc: Document): ReadonlyArray<LinkPromise> {

        const promises: LinkPromise[] = [];

        doc.querySelectorAll("link[rel=stylesheet]").forEach((link) => {

            const latch = new Latch<boolean>();
            promises.push(latch.get());

            link.addEventListener("load", () => {
                latch.resolve(true);
            });

            link.addEventListener("error", () => {
                // we're just waiting for them to be completed not their actual
                // status.
                latch.resolve(true);
            });

        });

        return promises;

    }

    private async loadIFrames(iframeRefs: IFrameRef[]) {

        for (const iframeRef of iframeRefs) {

            const resourceEntry = this.getResourceEntry(iframeRef.src);

            if (resourceEntry) {

                await this.loadResource(resourceEntry, iframeRef.iframe);

            } else {
                log.warn("No resource entry for URL: " + iframeRef.src);
            }

        }

    }

    /**
     * Al through all the iframes in this doc and fix them so that they don't
     * load as we are going to load them manually.
     */
    private neutralizeIFrames(doc: Document) {

        const result: IFrameRef[] = [];

        for (const iframe of Array.from(doc.querySelectorAll("iframe"))) {

            const src = iframe.getAttribute("src");

            if (src) {

                iframe.setAttribute("data-loader-src", src);
                iframe.removeAttribute("src");

                result.push({iframe, src});
                continue;

            } else {
                // this iframe isn't interesting to us as it does not have
                // a src attribute that we should be using.
            }

        }

        return result;

    }


}

export type LinkPromise = Promise<boolean>;

interface IFrameRef {
    readonly src: string;
    readonly iframe: HTMLIFrameElement;
}

