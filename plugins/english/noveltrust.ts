import { load } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

class NovelTrustPlugin implements Plugin.PluginBase {
  id = 'noveltrust';
  name = 'Novel Trust';
  icon = 'src/en/noveltrust/icon.png';
  site = 'https://noveltrust.com/';
  version = '1.0.0';

  /**
   * Convert a full NovelTrust URL into the path LNReader stores.
   */
  private normalizePath(url: string | undefined): string {
    if (!url) return '';

    if (url.startsWith(this.site)) {
      return url.slice(this.site.length);
    }

    if (url.startsWith('/')) {
      return url.slice(1);
    }

    try {
      const parsed = new URL(url);
      return parsed.pathname.replace(/^\/+/, '');
    } catch {
      return url.replace(/^\/+/, '');
    }
  }

  /**
   * Parse NovelTrust's novel cards.
   *
   * NovelTrust uses:
   *   .ul-list1
   *     .li
   *       .pic img
   *       .txt h3.tit a
   */
  private parseNovels(html: string): Plugin.NovelItem[] {
    const $ = load(html);
    const novels: Plugin.NovelItem[] = [];

    $('.ul-list1 .li').each((_, element) => {
      const link = $(element).find('.txt h3.tit a').first();
      const image = $(element).find('.pic img').first();

      const url = link.attr('href');
      const name =
        link.attr('title')?.trim() ||
        link.text().trim();

      if (!url || !name) return;

      novels.push({
        name,
        path: this.normalizePath(url),
        cover:
          image.attr('src') ||
          image.attr('data-src') ||
          defaultCover,
      });
    });

    return novels;
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
    }: Plugin.PopularNovelsOptions<{}>,
  ): Promise<Plugin.NovelItem[]> {
    let url: string;

    if (showLatestNovels) {
      url =
        this.site +
        'list/latest-release-novels/' +
        (pageNo > 1 ? `?page=${pageNo}` : '');
    } else {
      url =
        this.site +
        'list/most-popular-novels/' +
        (pageNo > 1 ? `?page=${pageNo}` : '');
    }

    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Could not reach Novel Trust (${response.status})`,
      );
    }

    return this.parseNovels(await response.text());
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel> {
    const url = this.site + novelPath;

    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Could not reach Novel Trust (${response.status})`,
      );
    }

    const html = await response.text();
    const $ = load(html);

    /*
     * NovelTrust exposes very useful OpenGraph metadata:
     *
     * og:novel:novel_name
     * og:novel:author
     * og:novel:genre
     * og:novel:status
     * og:image
     */
    const getMeta = (property: string): string => {
      return (
        $(`meta[property="${property}"]`)
          .attr('content')
          ?.trim() || ''
      );
    };

    const name =
      getMeta('og:novel:novel_name') ||
      $('h1').first().text().trim() ||
      'Unknown';

    const author =
      getMeta('og:novel:author') || 'Unknown';

    const genres =
      getMeta('og:novel:genre')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .join(', ');

    const cover =
      getMeta('og:image') ||
      defaultCover;

    const summary =
      getMeta('og:description') ||
      '';

    const statusText =
      getMeta('og:novel:status').toLowerCase();

    let status = NovelStatus.Unknown;

    if (
      statusText === 'ongoing' ||
      statusText === 'on-going'
    ) {
      status = NovelStatus.Ongoing;
    } else if (
      statusText === 'completed' ||
      statusText === 'complete'
    ) {
      status = NovelStatus.Completed;
    } else if (
      statusText === 'hiatus' ||
      statusText === 'on hiatus'
    ) {
      status = NovelStatus.OnHiatus;
    }

    /*
     * NovelTrust gives us 40 chapters per page.
     *
     * Page 1:
     *   /book/slug
     *
     * Page 2:
     *   /book/slug/2
     *
     * ...
     *
     * The final page is discovered from the Last link.
     */
    const chapters: Plugin.ChapterItem[] = [];

    const addChaptersFromPage = (
      pageHtml: string,
    ) => {
      const page = load(pageHtml);

      page('ul.ul-list5 li').each((_, element) => {
        const link = page(element)
          .find('a.con')
          .first();

        const chapterUrl = link.attr('href');

        const chapterName =
          link.attr('title')?.trim() ||
          link.text().trim();

        if (!chapterUrl || !chapterName) {
          return;
        }

        const numberMatch =
          chapterName.match(/chapter\s+(\d+(?:\.\d+)?)/i);

        chapters.push({
          name: chapterName,
          path: this.normalizePath(chapterUrl),
          chapterNumber: numberMatch
            ? parseFloat(numberMatch[1])
            : chapters.length + 1,
        });
      });
    };

    // Parse the first chapter page.
    addChaptersFromPage(html);

    /*
     * Find NovelTrust's final chapter-list page.
     *
     * Example:
     * /book/the-dukes-eldest-son-escaped-to-the-military/8
     */
    let lastPage = 1;

    $('div.page a').each((_, element) => {
      const href = $(element).attr('href');

      if (!href) return;

      const match = href.match(/\/(\d+)\/?$/);

      if (match) {
        lastPage = Math.max(
          lastPage,
          parseInt(match[1], 10),
        );
      }
    });

    /*
     * Fetch pages 2, 3, ... until the final page.
     */
    for (
      let pageNo = 2;
      pageNo <= lastPage;
      pageNo++
    ) {
      const pageUrl =
        `${this.site}${novelPath}/${pageNo}`;

      const pageResponse = await fetchApi(pageUrl);

      if (!pageResponse.ok) {
        throw new Error(
          `Could not fetch chapter list page ${pageNo} (${pageResponse.status})`,
        );
      }

      addChaptersFromPage(
        await pageResponse.text(),
      );
    }

    /*
     * Remove accidental duplicates and sort numerically.
     */
    const uniqueChapters = new Map<
      string,
      Plugin.ChapterItem
    >();

    for (const chapter of chapters) {
      if (!uniqueChapters.has(chapter.path)) {
        uniqueChapters.set(
          chapter.path,
          chapter,
        );
      }
    }

    const finalChapters = Array.from(
      uniqueChapters.values(),
    ).sort(
      (a, b) =>
        (a.chapterNumber ?? 0) -
        (b.chapterNumber ?? 0),
    );

    return {
      path: novelPath,
      name,
      cover,
      author,
      artist: '',
      genres,
      summary,
      status,
      chapters: finalChapters,
    };
  }

  async parseChapter(
    chapterPath: string,
  ): Promise<string> {
    /*
     * IMPORTANT:
     * We deliberately fetch the NovelTrust URL directly.
     *
     * We are NOT creating a NovelLive plugin and we are
     * NOT manually redirecting to NovelLive.
     *
     * If NovelTrust redirects this request, this test will
     * tell us whether LNReader's fetch layer can handle it.
     */
    const url = this.site + chapterPath;

    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Could not fetch chapter (${response.status})`,
      );
    }

    const html = await response.text();
    const $ = load(html);

    /*
     * First attempt: NovelTrust-style chapter containers.
     *
     * We use several fallbacks because we have not yet
     * inspected the chapter HTML itself.
     */

    const selectors = [
      '.epcontent',
      '.txt',
      '.chapter-content',
      '.entry-content',
      '.reading-content',
      '.content',
    ];

    for (const selector of selectors) {
      const content = $(selector).first();

      if (content.length) {
        /*
         * Remove things that shouldn't appear in the
         * chapter text.
         */
        content.find(
          'script, style, .ads, .ad, .advertisement',
        ).remove();

        const result = content.html();

        if (result && result.trim()) {
          return result.trim();
        }
      }
    }

    /*
     * Last-resort fallback:
     * return paragraphs from the page.
     */
    const paragraphs = $('p')
      .map((_, element) => {
        const text = $(element)
          .html()
          ?.trim();

        return text || '';
      })
      .get()
      .filter(Boolean);

    if (paragraphs.length) {
      return paragraphs.join('\n');
    }

    throw new Error(
      'Novel Trust: could not find chapter content.',
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    /*
     * NovelTrust's visible search form uses POST with
     * the field "searchkey".
     *
     * For this first test, we use the site's search URL.
     * If NovelTrust requires the POST request strictly,
     * search will be the first thing we fix after testing.
     */
    const url =
      this.site +
      'search/?s=' +
      encodeURIComponent(searchTerm);

    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Could not search Novel Trust (${response.status})`,
      );
    }

    return this.parseNovels(
      await response.text(),
    );
  }

  resolveUrl = (
    path: string,
    _isNovel?: boolean,
  ) => {
    return this.site + path;
  };
}

export default new NovelTrustPlugin();
