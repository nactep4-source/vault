// What GET /api/stream/direct needs from any one source, so the route can treat
// the long-standing vidora sources and the later VidCore/VidSrc ones alike.

export type DirectSourceContext = {
  type: 'movie' | 'tv';
  /** TMDB id, as given in the query string. */
  tmdbId: string;
  season: number;
  episode: number;
};

export type DirectSourceStream = {
  /** Which backend inside the source answered, for the response's `provider`. */
  provider: string;
  title: string | null;
  /** The HLS/file link itself. */
  url: string;
  /**
   * Referer the CDN demands for this link. Browsers cannot send it from another
   * origin, so the link is also handed out through /api/stream/proxy, which
   * re-sends it server-side (and derives `Origin` from it).
   */
  referer: string;
  /** Subtitle tracks, when the source publishes them. */
  tracks?: { label?: string; file?: string }[];
};
