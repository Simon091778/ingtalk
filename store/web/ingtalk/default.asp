<%@ Language="VBScript" CodePage="65001" %>
<%
Response.Status = "301 Moved Permanently"
Dim redirectLang
redirectLang = LCase(Trim(Request.QueryString("lang")))
If redirectLang = "ko" Or redirectLang = "en" Then
  Response.AddHeader "Location", "index.asp?lang=" & redirectLang
Else
  Response.AddHeader "Location", "index.asp"
End If
Response.End
%>
