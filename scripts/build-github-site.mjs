import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "store", "web", "ingtalk");
const outputDir = join(root, "github-site");

const pages = ["index", "terms", "privacy", "deletion", "community", "support"];

function metadata(source, name, lang) {
  const suffix = lang === "en" ? "En" : "Ko";
  const title = source.match(new RegExp(`pageTitle${suffix}="([^"]+)"`))?.[1];
  const description = source.match(new RegExp(`pageDescription${suffix}="([^"]+)"`))?.[1];
  const current = source.match(/currentPage="([^"]+)"/)?.[1] ?? name;
  if (!title || !description) throw new Error(`Missing metadata in ${name}.asp`);
  return { title, description, current };
}

function renderAsp(fragment, lang, linkFor) {
  const tokens = fragment.split(/(<%[\s\S]*?%>)/g);
  const active = [true];
  let result = "";

  for (const token of tokens) {
    if (!token.startsWith("<%")) {
      if (active.every(Boolean)) result += token;
      continue;
    }

    const code = token.slice(2, -2).trim();
    if (/^If lang\s*=\s*"en" Then$/i.test(code)) {
      active.push(lang === "en");
    } else if (/^Else$/i.test(code)) {
      active[active.length - 1] = !active[active.length - 1];
    } else if (/^End If$/i.test(code)) {
      active.pop();
    } else if (active.every(Boolean)) {
      const langUrl = code.match(/^=\s*LangUrl\("([^"]+\.asp)"\)$/i);
      if (langUrl) result += linkFor(langUrl[1].replace(/\.asp$/i, ".html"));
    }
  }

  return result.trim();
}

function bodyFrom(source, lang, linkFor) {
  const start = source.indexOf("<main");
  const end = source.lastIndexOf("</main>");
  if (start < 0 || end < 0) throw new Error("Missing <main> element");
  return renderAsp(source.slice(start, end + 7), lang, linkFor);
}

function pathContext(lang, nested = false) {
  const depth = (lang === "en" ? 1 : 0) + (nested ? 1 : 0);
  const toRoot = "../".repeat(depth);
  const linkFor = (file) => nested ? `../${file}` : file;
  const css = `${toRoot}styles.css`;
  return { depth, toRoot, linkFor, css };
}

function pageHeader({ lang, current, nested = false }) {
  const { linkFor, toRoot } = pathContext(lang, nested);
  const labels = lang === "en"
    ? { brand: "Ingtalk", skip: "Skip to content", nav: "Main navigation", terms: "Terms", privacy: "Privacy", deletion: "Delete account", community: "Community", support: "Support" }
    : { brand: "잉톡", skip: "본문으로 바로가기", nav: "주요 메뉴", terms: "이용약관", privacy: "개인정보", deletion: "계정 삭제", community: "운영정책", support: "고객지원" };
  const nav = ["terms", "privacy", "deletion", "community", "support"]
    .map((name) => `<a${current === name ? ' aria-current="page"' : ""} href="${linkFor(`${name}.html`)}">${labels[name]}</a>`)
    .join("");
  const home = linkFor("index.html");
  const ko = lang === "ko"
    ? (nested ? "./" : `${current === "home" ? "index" : current}.html`)
    : `${toRoot}${nested ? "child-safety/" : current === "home" ? "index.html" : `${current}.html`}`;
  const en = lang === "en"
    ? (nested ? "./" : `${current === "home" ? "index" : current}.html`)
    : `${nested ? "../" : ""}en/${nested ? "child-safety/" : current === "home" ? "index.html" : `${current}.html`}`;
  return `<body><a class="skip" href="#main">${labels.skip}</a>
<header class="site-header"><div class="header-inner"><a class="brand" href="${home}">${labels.brand}</a><div class="header-actions"><nav class="nav" aria-label="${labels.nav}">${nav}</nav><nav class="language-switch" aria-label="Language"><a${lang === "ko" ? ' aria-current="true"' : ""} href="${ko}" lang="ko">한국어</a><span aria-hidden="true">|</span><a${lang === "en" ? ' aria-current="true"' : ""} href="${en}" lang="en">English</a></nav></div></div></header>`;
}

function pageFooter(lang, nested = false) {
  const { linkFor } = pathContext(lang, nested);
  const childSafety = nested ? "./" : "child-safety/";
  if (lang === "en") {
    return `<footer class="site-footer"><div class="footer-inner"><div class="footer-links"><a href="${linkFor("terms.html")}">Terms of Service</a><a href="${linkFor("privacy.html")}">Privacy Policy</a><a href="${linkFor("deletion.html")}">Account deletion</a><a href="${childSafety}">Child safety</a><a href="${linkFor("support.html")}">Support</a></div><div>Itembus · Representative: Yongil Cho · 2F, Suite 215, 4236 Donghae-daero, Sokcho-si, Gangwon State, Republic of Korea<br>Support: 1555-1645 · itembus@itembus.com</div></div></footer></body></html>`;
  }
  return `<footer class="site-footer"><div class="footer-inner"><div class="footer-links"><a href="${linkFor("terms.html")}">이용약관</a><a href="${linkFor("privacy.html")}">개인정보처리방침</a><a href="${linkFor("deletion.html")}">계정 삭제</a><a href="${childSafety}">아동 안전</a><a href="${linkFor("support.html")}">고객지원</a></div><div>아이템버스 · 대표자 조용일 · 강원특별자치도 속초시 동해대로 4236, 2층 215호<br>고객지원 1555-1645 · itembus@itembus.com</div></div></footer></body></html>`;
}

function documentHtml({ lang, title, description, current, body, nested = false }) {
  const { css } = pathContext(lang, nested);
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="description" content="${description}"><link rel="stylesheet" href="${css}"></head>
${pageHeader({ lang, current, nested })}
${body}
${pageFooter(lang, nested)}
`;
}

function outputPath(lang, name, nested = false) {
  const languageDir = lang === "en" ? join(outputDir, "en") : outputDir;
  return nested ? join(languageDir, "child-safety", "index.html") : join(languageDir, `${name}.html`);
}

function writePage(path, html) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html, "utf8");
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(join(sourceDir, "styles.css"), join(outputDir, "styles.css"));
cpSync(join(sourceDir, "app-ads.txt"), join(outputDir, "app-ads.txt"));

for (const name of pages) {
  const source = readFileSync(join(sourceDir, `${name}.asp`), "utf8");
  for (const lang of ["ko", "en"]) {
    const meta = metadata(source, name, lang);
    const { linkFor } = pathContext(lang);
    const body = bodyFrom(source, lang, linkFor);
    writePage(outputPath(lang, name), documentHtml({ lang, ...meta, body }));
  }
}

const childSource = readFileSync(join(sourceDir, "child-safety", "default.asp"), "utf8");
for (const lang of ["ko", "en"]) {
  const { linkFor } = pathContext(lang, true);
  const title = lang === "en" ? "Ingtalk Child Safety Standards" : "잉톡 아동 안전 표준";
  const description = lang === "en" ? "Ingtalk standards against child sexual abuse and exploitation" : "잉톡의 아동 성적 학대 및 착취 방지 기준";
  const body = bodyFrom(childSource, lang, linkFor)
    .replaceAll(/\.\.\/([a-z-]+)\.asp\?lang=(?:ko|en)/g, "../$1.html")
    .replaceAll(/href="\?lang=(?:ko|en)"/g, 'href="./"');
  writePage(outputPath(lang, "child-safety", true), documentHtml({ lang, title, description, current: "child-safety", body, nested: true }));
}

writeFileSync(join(outputDir, ".nojekyll"), "", "utf8");
writeFileSync(join(outputDir, "README.md"), `# 잉톡 정적 사이트

이 폴더는 \`store/web/ingtalk/\`의 Classic ASP 원본에서 생성한 GitHub Pages/Vercel 배포용 정적 사이트입니다.

원본 변경 후 저장소 루트에서 다음 명령으로 다시 생성합니다.

\`\`\`powershell
node scripts/build-github-site.mjs
\`\`\`

한국어 페이지는 이 폴더의 루트에 있고 영문 페이지는 \`en/\`에 있습니다.
`, "utf8");
console.log(`Generated static site at ${outputDir}`);
