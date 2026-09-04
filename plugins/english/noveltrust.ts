import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';
import { load } from 'cheerio';

class NovelTrustPlugin implements Plugin.PluginBase {
  id = 'noveltrust';
  name = 'Novel Trust';
  icon = 'src/en/noveltrust/icon.png';
  site = 'https://noveltrust.com/';
  version = '1.0.2';

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

  private parseNovels(html: string): Plugin.NovelItem[] {
    const $ = load(html);
    const novels: Plugin.NovelItem[] = [];

    /*
     * NovelTrust's current listing layout:
     *
     * .ul-list1
     *   .li
     *     .pic img
     *     .txt h3.tit a
     */
    $('.ul-list1 .li').each((_, element) => {
      const link = $(element)
        .find('.txt h3.tit a')
        .first();

      const image = $(element)
        .find('.pic img')
        .first();

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
    let basePath: string;

    if (showLatestNovels) {
      basePath = 'list/latest-release-novels';
    } else {
      basePath = 'list/most-popular-novels';
    }

    const url =
      pageNo <= 1
        ? this.site + basePath
        : `${this.site}${basePath}/${pageNo}`;

    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Novel Trust returned HTTP ${response.status}`,
      );
    }

    return this.parseNovels(
      await response.text(),
    );
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel> {
    const url = this.site + novelPath;

    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Novel Trust returned HTTP ${response.status}`,
      );
    }

    const html = await response.text();
    const $ = load(html);

    const meta = (name: string): string =>
      $(`meta[property="${name}"]`)
        .attr('content')
        ?.trim() || '';

    const name =
      meta('og:novel:novel_name') ||
      $('h1').first().text().trim() ||
      'Unknown';

    const author =
      meta('og:novel:author') ||
      'Unknown';

    const genres =
      meta('og:novel:genre')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
        .join(', ');

    const cover =
      meta('og:image') ||
      defaultCover;

    /*
     * NovelTrust's description is exposed through
     * og:description.
     */
    const summary =
      meta('og:description');

    const statusText =
      meta('og:novel:status')
        .toLowerCase();

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

    const chapters: Plugin.ChapterItem[] = [];

    /*
     * Parse one NovelTrust chapter-list page.
     *
     * Current structure:
     *
     * <ul class="ul-list5">
     *   <li>
     *     <a class="con" href="...">
     *       Chapter 1 ...
     *     </a>
     *   </li>
     * </ul>
     */
    const parseChapterPage = (
      pageHtml: string,
    ) => {
      const page = load(pageHtml);

      page('ul.ul-list5 > li').each(
        (_, element) => {
          const link = page(element)
            .find('a.con')
            .first();

          const chapterUrl =
            link.attr('href');

          const chapterName =
            link.attr('title')?.trim() ||
            link.text().trim();

          if (!chapterUrl || !chapterName) {
            return;
          }

          const number =
            chapterName.match(
              /chapter\s+(\d+(?:\.\d+)?)/i,
            );

          chapters.push({
            name: chapterName,
            path: this.normalizePath(
              chapterUrl,
            ),
            chapterNumber: number
              ? parseFloat(number[1])
              : chapters.length + 1,
          });
        },
      );
    };

    /*
     * Page 1 is the novel page itself.
     */
    parseChapterPage(html);

    /*
     * NovelTrust uses:
     *
     * /book/slug
     * /book/slug/2
     * /book/slug/3
     * ...
     *
     * The Last link tells us the final page.
     */
    let lastPage = 1;

    $('div.page a').each(
      (_, element) => {
        const href =
          $(element).attr('href');

        if (!href) return;

        const match =
          href.match(/\/(\d+)\/?$/);

        if (match) {
          lastPage = Math.max(
            lastPage,
            parseInt(match[1], 10),
          );
        }
      },
    );

    /*
     * Fetch all remaining chapter pages.
     */
    for (
      let pageNo = 2;
      pageNo <= lastPage;
      pageNo++
    ) {
      const pageUrl =
        `${this.site}${novelPath}/${pageNo}`;

      const pageResponse =
        await fetchApi(pageUrl);

      if (!pageResponse.ok) {
        throw new Error(
          `Novel Trust chapter page ${pageNo} returned HTTP ${pageResponse.status}`,
        );
      }

      parseChapterPage(
        await pageResponse.text(),
      );
    }

    /*
     * Remove duplicates.
     */
    const unique = new Map<
      string,
      Plugin.ChapterItem
    >();

    for (const chapter of chapters) {
      if (!unique.has(chapter.path)) {
        unique.set(
          chapter.path,
          chapter,
        );
      }
    }

    const finalChapters =
      Array.from(unique.values()).sort(
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
     * Deliberately request NovelTrust directly.
     *
     * We do NOT manually redirect to NovelLive.
     */
    const url =
      this.site + chapterPath;

    const response =
      await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Novel Trust chapter returned HTTP ${response.status}`,
      );
    }

    const html =
      await response.text();

    const $ = load(html);

    /*
     * First try common NovelTrust reader
     * containers.
     */
    const selectors = [
      '.epcontent',
      '.entry-content',
      '.reading-content',
      '.chapter-content',
      '.txt',
    ];

    for (const selector of selectors) {
      const content =
        $(selector).first();

      if (content.length) {
        content.find(
          'script, style, iframe, ins, .ads, .ad',
        ).remove();

        const result =
          content.html()?.trim();

        if (result) {
          return result;
        }
      }
    }

    /*
     * Fallback: collect paragraph HTML.
     */
    const paragraphs = $('p')
      .map((_, element) =>
        $(element).html()?.trim() || '',
      )
      .get()
      .filter(Boolean);

    if (paragraphs.length) {
      return paragraphs.join('\n');
    }

    throw new Error(
      'Novel Trust: chapter content could not be found.',
    );
  }

  async searchNovels(
    searchTerm: string,
    _pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    /*
     * NovelTrust's actual search form is:
     *
     * POST /search/
     * searchkey=<term>
     *
     * This is NOT ?s=<term>.
     */
    const body =
      new URLSearchParams();

    body.set(
      'searchkey',
      searchTerm,
    );

    const response =
      await fetchApi(
        `${this.site}search/`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        },
      );

    if (!response.ok) {
      throw new Error(
        `Novel Trust search returned HTTP ${response.status}`,
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
