import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

class NovelTrustPlugin implements Plugin.PluginBase {
  id = 'noveltrust';
  name = 'Novel Trust';
  icon = 'https://noveltrust.com/favicon.ico';
  site = 'https://noveltrust.com';
  version = '1.0.0';

  filters = undefined;

  webStorageUtilized = false;

  normalizePath(path?: string, withDomain = true): string | undefined {
    if (!path) {
      return undefined;
    }

    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }

    if (path.startsWith('/')) {
      return withDomain ? this.site + path : path;
    }

    return withDomain ? `${this.site}/${path}` : `/${path}`;
  }

  async getPage(url: string): Promise<string> {
    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Novel Trust request failed: ${response.status} ${response.statusText}`,
      );
    }

    return await response.text();
  }

  parseNovelCards(body: string): Plugin.NovelItem[] {
    const $ = loadCheerio(body);
    const novels: Plugin.NovelItem[] = [];

    $('.ul-list1 .li').each((_, element) => {
      const item = $(element);

      const link = item.find('.txt h3.tit a').first();
      const image = item.find('.pic img').first();

      const name = link.text().trim();
      const path = this.normalizePath(link.attr('href'));
      const cover =
        this.normalizePath(image.attr('src')) ?? defaultCover;

      if (name && path) {
        novels.push({
          name,
          path,
          cover,
        });
      }
    });

    return novels;
  }

  async popularNovels(
    pageNo: number,
    _options?: Plugin.PopularNovelsOptions<undefined>,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      pageNo <= 1
        ? `${this.site}/list/latest-release-novels/`
        : `${this.site}/list/latest-release-novels/${pageNo}`;

    const body = await this.getPage(url);

    return this.parseNovelCards(body);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // Novel Trust's search form is POST-based.
    // It does not expose conventional ?page= pagination,
    // so only page 1 is meaningful.
    if (pageNo > 1) {
      return [];
    }

    const url = `${this.site}/search/`;

    const body = new URLSearchParams({
      searchkey: searchTerm,
    }).toString();

    const response = await fetchApi(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Novel Trust search failed: ${response.status} ${response.statusText}`,
      );
    }

    const html = await response.text();

    return this.parseNovelCards(html);
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel> {
    const url = this.normalizePath(novelPath);

    if (!url) {
      throw new Error('Invalid Novel Trust novel URL');
    }

    const firstPageHtml = await this.getPage(url);
    const $ = loadCheerio(firstPageHtml);

    const title =
      $('meta[property="og:novel:novel_name"]').attr('content')?.trim() ||
      $('h1').first().text().trim() ||
      'Untitled';

    const cover =
      $('meta[property="og:image"]').attr('content') ||
      $('img').first().attr('src') ||
      defaultCover;

    const author =
      $('meta[property="og:novel:author"]').attr('content')?.trim() ||
      $('a[href*="/author/"]').first().text().trim() ||
      undefined;

    const genres =
      $('meta[property="og:novel:genre"]').attr('content')
        ?.split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .join(', ') ||
      undefined;

    const statusText =
      $('meta[property="og:novel:status"]').attr('content')?.trim() ||
      '';

    const summary =
      $('meta[property="og:description"]').attr('content')?.trim() ||
      $('.summary').first().text().trim() ||
      undefined;

    const ratingText = $('meta[property="og:novel:rating"]').attr(
      'content',
    );

    const rating = ratingText
      ? Number.parseFloat(ratingText)
      : undefined;

    const novel: Plugin.SourceNovel = {
      name: title,
      path: url,
      cover: this.normalizePath(cover) ?? defaultCover,
      author,
      genres,
      summary,
      rating,
      status:
        statusText.toLowerCase() === 'completed'
          ? NovelStatus.Completed
          : NovelStatus.Ongoing,
      chapters: [],
    };

    /*
     * Novel Trust displays 40 chapters per page.
     *
     * The <select id="indexselect"> contains:
     * C.1 - C.40
     * C.41 - C.80
     * ...
     *
     * The option values tell us how many chapter pages exist.
     */
    let maxChapterPage = 1;

    $('#indexselect option').each((_, element) => {
      const value = Number.parseInt(
        $(element).attr('value') || '',
        10,
      );

      if (Number.isFinite(value)) {
        maxChapterPage = Math.max(maxChapterPage, value);
      }
    });

    const chapters: Plugin.ChapterItem[] = [];

    for (let page = 1; page <= maxChapterPage; page++) {
      let pageHtml = firstPageHtml;

      if (page > 1) {
        const pageUrl = `${url}/${page}`;
        pageHtml = await this.getPage(pageUrl);
      }

      const page$ = loadCheerio(pageHtml);

      page$('ul.ul-list5 > li').each((_, element) => {
        const link = page$(element).find('a.con').first();

        const name = link.text().trim();
        const path = this.normalizePath(link.attr('href'));

        if (!name || !path) {
          return;
        }

        const match = name.match(/chapter\s+(\d+(?:\.\d+)?)/i);

        const chapterNumber = match
          ? Number.parseFloat(match[1])
          : undefined;

        chapters.push({
          name,
          path,
          chapterNumber,
        });
      });
    }

    // Remove accidental duplicates while preserving order.
    const uniqueChapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();

    for (const chapter of chapters) {
      if (seen.has(chapter.path)) {
        continue;
      }

      seen.add(chapter.path);
      uniqueChapters.push(chapter);
    }

    novel.chapters = uniqueChapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.normalizePath(chapterPath);

    if (!url) {
      throw new Error('Invalid Novel Trust chapter URL');
    }

    /*
     * IMPORTANT:
     *
     * This deliberately requests the Novel Trust URL.
     * We are NOT adding NovelLive-specific handling here.
     *
     * If Novel Trust redirects the request to NovelLive,
     * this function will tell us that the chapter delivery
     * itself is the problem.
     */
    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Novel Trust chapter request failed: ${response.status} ${response.statusText}`,
      );
    }

    const html = await response.text();
    const $ = loadCheerio(html);

    /*
     * Only accept content that actually looks like a
     * Novel Trust chapter page.
     */
    const canonical =
      $('link[rel="canonical"]').attr('href') || '';

    const novelName =
      $('meta[property="og:novel:novel_name"]').attr('content') || '';

    const isNovelTrustPage =
      canonical.includes('noveltrust.com') ||
      novelName.length > 0 ||
      $('body').text().includes('NOVEL TRUST');

    if (!isNovelTrustPage) {
      throw new Error(
        'Novel Trust redirected to another site while loading this chapter.',
      );
    }

    /*
     * Novel Trust chapter content.
     *
     * Try the site's own reading container first,
     * then a few generic containers without interpreting
     * another site's page structure.
     */
    const selectors = [
      '.txt',
      '.chapter-content',
      '.reading-content',
      '.entry-content',
      '.epcontent',
    ];

    let content = null;

    for (const selector of selectors) {
      const candidate = $(selector).first();

      if (candidate.length && candidate.text().trim().length > 0) {
        content = candidate;
        break;
      }
    }

    if (!content) {
      throw new Error(
        'Novel Trust chapter content could not be found.',
      );
    }

    /*
     * Remove elements that should not be displayed as chapter text.
     */
    content
      .find('script, style, noscript, iframe')
      .remove();

    return content.html()?.trim() || '';
  }

  resolveUrl = (path: string, _isNovel?: boolean): string => {
    return this.normalizePath(path) || path;
  };
}

export default new NovelTrustPlugin();

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
