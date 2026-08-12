FROM node:22-alpine
WORKDIR /app

# CJK + emoji fonts for server-side rendering (Typst PDF export + whiteboard
# image export).
#
# The PDF export renders the document to Typst source and compiles it with the
# standalone `typst` binary (see below). Typst resolves fonts from the system
# font book, so the image must carry real CJK and emoji faces:
#   - font-noto-cjk  → Chinese/Japanese/Korean glyphs. This package ships BOTH
#     Noto Sans CJK and Noto Serif CJK (NotoSansCJK-*.ttc / NotoSerifCJK-*.ttc)
#     under /usr/share/fonts/noto — the OSS Source Han Sans/Serif faces the PDF
#     export maps CJK font choices onto (renderTypst.ts CJK_FONT_MAP). SIL OFL,
#     free to subset-embed and redistribute inside the exported PDF.
#   - font-noto-emoji → colour emoji (matches what the editor shows)
# The whiteboard PNG export (@napi-rs/canvas / Skia, whiteboard/exportScene.ts)
# draws text with these same faces: it loads this directory explicitly at
# runtime (GlobalFonts.loadFontsFromDir('/usr/share/fonts')), so no fontconfig
# or extra system library is required.
RUN apk add --no-cache \
      font-noto=2026.06.01-r0 \
      font-noto-cjk=0_git20220127-r1 \
      font-noto-emoji=2.051-r0

# Point the Typst PDF export at the font dir explicitly (--font-path) so the
# embedded OSS CJK families (Noto Sans/Serif CJK SC) the document maps to resolve
# deterministically regardless of system font-book state; typst subset-embeds
# only the glyphs actually used, keeping the PDF small. See typstService.ts.
ENV TYPST_EXPORT_FONT_PATH=/usr/share/fonts

# Typst binary for server-side PDF export (renderTypst.ts / typstService.ts).
#
# Typst is a single static Rust binary (~30MB) with no browser or LaTeX
# dependency and no resident process — each export spawns a short-lived,
# network-less, sandboxed child. We fetch the musl static release and drop it on
# PATH. The version is pinned for reproducible builds; bump deliberately.
# Compile concurrency is capped in typstService.ts (TYPST_EXPORT_MAX_CONCURRENT,
# default 2).
ARG TYPST_VERSION=v0.13.1
RUN apk add --no-cache --virtual .typst-fetch curl=8.21.0-r0 tar=1.35-r5 xz=5.8.3-r0 \
    && ARCH="$(uname -m)" \
    && case "$ARCH" in \
         x86_64) TARGET=x86_64-unknown-linux-musl ;; \
         aarch64) TARGET=aarch64-unknown-linux-musl ;; \
         *) echo "unsupported arch $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/typst/typst/releases/download/${TYPST_VERSION}/typst-${TARGET}.tar.xz" -o /tmp/typst.tar.xz \
    && tar -xJf /tmp/typst.tar.xz -C /tmp \
    && install -m 0755 "/tmp/typst-${TARGET}/typst" /usr/local/bin/typst \
    && rm -rf /tmp/typst.tar.xz "/tmp/typst-${TARGET}" \
    && apk del .typst-fetch \
    && typst --version

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

ENV NODE_ENV=production
# 3000 = public REST API, 1234 = Hocuspocus collab WS, 9090 = optional
# internal-only API (bound only when INTERNAL_HTTP_PORT is set; serves
# /internal/html). EXPOSE is documentation/intra-network only — never publish
# 9090 to the host (caveat: `docker run -P` publishes EVERY EXPOSEd port to an
# ephemeral host port, so never use -P with this image; deployments use explicit
# `ports:`/`expose:`). If a deployment picks a port other than 9090, update this
# line and the compose `expose:` in docs/DEPLOYMENT.md §0 to match.
EXPOSE 3000 1234 9090

CMD ["node", "dist/index.js"]
