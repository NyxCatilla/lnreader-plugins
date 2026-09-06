import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { CheerioAPI, load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { Filters } from '@libs/filterInputs';

class NovelTrustPlugin implements Plugin.PluginBase {
  id = 'noveltrust';
  name = 'Novel Trust';
  icon = 'src/en/noveltrust/icon.png';
  site = 'https://noveltrust.com';
  version = '1.0.0';

  filters = {} satisfies Filters;

  webStorageUtilized = false;

  normalizePath(
    path: string | undefined,
    withDomain: boolean = true,
  ): string | undefined {
    if (!path) return undefined;

    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }

    if (path.startsWith('/')) {
      return withDomain ? this.site + path : path;
    }

    return withDomain ? `${this.site}/${path}` : `/${path}`;
  }

  async getHtml(url: string): Promise<string> {
    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Novel Trust request failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.text();
  }

  parseNovelCards($: CheerioAPI): Plugin.NovelItem[] {
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
        novels.push({ name, path, cover });
      }
    });

    return novels;
  }

  async popularNovels(
    pageNo: number,
    options: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    // Novel Trust uses /2, /3, ... for later list pages.
    const url =
      pageNo <= 1
        ? `${this.site}/list/latest-release-novels/`
        : `${this.site}/list/latest-release-novels/${pageNo}`;

    const html = await this.getHtml(url);
    return this.parseNovelCards(loadCheerio(html));
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // Novel Trust's search form is POST-based.
    // It does not expose search pagination in the form itself.
    if (pageNo > 1) return [];

    const body =
      `searchkey=${encodeURIComponent(searchTerm)}`;

    const response = await fetchApi(`${this.site}/search/`, {
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
    return this.parseNovelCards(loadCheerio(html));
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel> {
    const url = this.normalizePath(novelPath);

    if (!url) {
      throw new Error('Invalid Novel Trust novel URL');
    }

    const firstHtml = await this.getHtml(url);
    const $ = loadCheerio(firstHtml);

    const name =
      $('meta[property="og:novel:novel_name"]').attr('content')?.trim() ||
      $('h1').first().text().trim() ||
      'Untitled';

    const cover =
      $('meta[property="og:image"]').attr('content') ||
      defaultCover;

    const author =
      $('meta[property="og:novel:author"]').attr('content')?.trim();

    const genres =
      $('meta[property="og:novel:genre"]')
        .attr('content')
        ?.split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .join(', ');

    const summary =
      $('meta[property="og:description"]').attr('content')?.trim();

    const status =
      $('meta[property="og:novel:status"]').attr('content')?.trim();

    const ratingText =
      $('meta[property="og:novel:rating"]').attr('content');

    const rating = ratingText
      ? Number.parseFloat(ratingText)
      : undefined;

    let maxPage = 1;

    $('#indexselect option').each((_, element) => {
      const value = Number.parseInt(
        $(element).attr('value') || '',
        10,
      );

      if (Number.isFinite(value)) {
        maxPage = Math.max(maxPage, value);
      }
    });

    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPage; page++) {
      const html =
        page === 1
          ? firstHtml
          : await this.getHtml(`${url}/${page}`);

      const page$ = loadCheerio(html);

      page$('ul.ul-list5 > li').each((_, element) => {
        const link = page$(element).find('a.con').first();

        const chapterName = link.text().trim();
        const chapterPath = this.normalizePath(link.attr('href'));

        if (!chapterName || !chapterPath || seen.has(chapterPath)) {
          return;
        }

        seen.add(chapterPath);

        const match = chapterName.match(
          /chapter\s+(\d+(?:\.\d+)?)/i,
        );

        chapters.push({
          name: chapterName,
          path: chapterPath,
          chapterNumber: match
            ? Number.parseFloat(match[1])
            : undefined,
        });
      });
    }

    return {
      name,
      path: url,
      cover: this.normalizePath(cover) ?? defaultCover,
      author,
      genres,
      summary,
      status,
      rating,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.normalizePath(chapterPath);

    if (!url) {
      throw new Error('Invalid Novel Trust chapter URL');
    }

    // Deliberately request Novel Trust only.
    // No NovelLive handling is implemented here.
    const response = await fetchApi(url);

    if (!response.ok) {
      throw new Error(
        `Novel Trust chapter request failed: ${response.status} ${response.statusText}`,
      );
    }

    const html = await response.text();
    const $ = loadCheerio(html);

    const canonical =
      $('link[rel="canonical"]').attr('href') || '';

    const novelName =
      $('meta[property="og:novel:novel_name"]').attr('content') || '';

    if (
      !canonical.includes('noveltrust.com') &&
      !novelName
    ) {
      throw new Error(
        'Novel Trust redirected the chapter to another site.',
      );
    }

    const selectors = [
      '.epcontent',
      '.entry-content',
      '.reading-content',
      '.chapter-content',
      '.txt',
    ];

    let content = null;

    for (const selector of selectors) {
      const candidate = $(selector).first();

      if (candidate.length && candidate.text().trim()) {
        content = candidate;
        break;
      }
    }

    if (!content) {
      throw new Error(
        'Novel Trust chapter content was not found.',
      );
    }

    content.find('script, style, noscript, iframe').remove();

    return content.html()?.trim() || '';
  }

  resolveUrl = (path: string, _isNovel?: boolean): string =>
    this.normalizePath(path) || path;
}

export default new NovelTrustPlugin();
