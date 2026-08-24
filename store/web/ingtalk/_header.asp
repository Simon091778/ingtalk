<%
Dim requestedLang, lang
requestedLang = LCase(Trim(Request.QueryString("lang")))
If requestedLang = "ko" Or requestedLang = "en" Then
  lang = requestedLang
  Response.Cookies("ingtalk_site_lang") = lang
  Response.Cookies("ingtalk_site_lang").Expires = DateAdd("yyyy", 1, Now())
  Response.Cookies("ingtalk_site_lang").Secure = True
Else
  lang = LCase(Trim(Request.Cookies("ingtalk_site_lang")))
  If lang <> "ko" And lang <> "en" Then lang = "ko"
End If

Function LangUrl(path)
  LangUrl = path & "?lang=" & lang
End Function

Dim pageTitle, pageDescription
If lang = "en" Then
  pageTitle = pageTitleEn
  pageDescription = pageDescriptionEn
Else
  pageTitle = pageTitleKo
  pageDescription = pageDescriptionKo
End If
%><!doctype html>
<html lang="<%=lang%>"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title><%=pageTitle%></title><meta name="description" content="<%=pageDescription%>"><link rel="stylesheet" href="styles.css"></head>
<body><a class="skip" href="#main"><% If lang="en" Then %>Skip to content<% Else %>본문으로 바로가기<% End If %></a>
<header class="site-header"><div class="header-inner"><a class="brand" href="<%=LangUrl("index.asp")%>"><% If lang="en" Then %>Ingtalk<% Else %>잉톡<% End If %></a><div class="header-actions"><nav class="nav" aria-label="<% If lang="en" Then %>Main navigation<% Else %>주요 메뉴<% End If %>"><a <% If currentPage="terms" Then Response.Write("aria-current=""page""") %> href="<%=LangUrl("terms.asp")%>"><% If lang="en" Then %>Terms<% Else %>이용약관<% End If %></a><a <% If currentPage="privacy" Then Response.Write("aria-current=""page""") %> href="<%=LangUrl("privacy.asp")%>"><% If lang="en" Then %>Privacy<% Else %>개인정보<% End If %></a><a <% If currentPage="deletion" Then Response.Write("aria-current=""page""") %> href="<%=LangUrl("deletion.asp")%>"><% If lang="en" Then %>Delete account<% Else %>계정 삭제<% End If %></a><a <% If currentPage="community" Then Response.Write("aria-current=""page""") %> href="<%=LangUrl("community.asp")%>"><% If lang="en" Then %>Community<% Else %>운영정책<% End If %></a><a <% If currentPage="support" Then Response.Write("aria-current=""page""") %> href="<%=LangUrl("support.asp")%>"><% If lang="en" Then %>Support<% Else %>고객지원<% End If %></a></nav><nav class="language-switch" aria-label="Language"><a <% If lang="ko" Then Response.Write("aria-current=""true""") %> href="<%=currentFile%>?lang=ko" lang="ko">한국어</a><span aria-hidden="true">|</span><a <% If lang="en" Then Response.Write("aria-current=""true""") %> href="<%=currentFile%>?lang=en" lang="en">English</a></nav></div></div></header>
