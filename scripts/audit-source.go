// Compares openapi.json with the rclone source for one release.
//
// It covers what scripts/check-contract.mjs can't reach, such as routes that need
// a particular backend. It makes a shallow clone of the release tag into
// .work/cache and only parses the Go code, so nothing from that tree runs.
//
// For each route it compares the params rclone reads, whether they are required,
// their types when they arrive in a JSON body, the keys in the response, and the
// auth setting. The parsing relies on heuristics, so the tables below list the
// places where it needs help, each with a reason.
//
// OPENAPI_RCLONE_VERSION checks a different version, or "latest".
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const modPrefix = "github.com/rclone/rclone/"

// Routes in rclone that the spec leaves out on purpose.
var notInSpec = map[string]string{
	"rc/fatal": "test helper that stops the server",
	"rc/panic": "test helper for error handling",
}

// Params rclone reads only for backwards compatibility, or reads but ignores.
// The spec documents the current form.
var undocumentedParams = map[string][]string{
	"config/unlock":   {"config_password"},
	"config/create":   {"obscure", "noObscure"},
	"config/update":   {"obscure", "noObscure"},
	"config/password": {"opt", "obscure", "noObscure"},
	"sync/bisync":     {"backupdir1", "backupdir2"},
}

// Params read in ways the parser can't follow, such as through a local closure.
var extraParams = map[string][]Param{
	"operations/check": {
		{Name: "combined", Getter: "GetBool", Req: "no"},
		{Name: "missingOnSrc", Getter: "GetBool", Req: "no"},
		{Name: "missingOnDst", Getter: "GetBool", Req: "no"},
		{Name: "match", Getter: "GetBool", Req: "no"},
		{Name: "differ", Getter: "GetBool", Req: "no"},
		{Name: "error", Getter: "GetBool", Req: "no"},
	},
	"vfs/refresh": {
		{Name: "recursive", Getter: "stringAssert", Req: "no"},
		{Name: "dir", Getter: "stringAssert", Req: "no"},
	},
	"vfs/forget": {
		{Name: "file", Getter: "stringAssert", Req: "no"},
		{Name: "dir", Getter: "stringAssert", Req: "no"},
	},
	"cache/fetch": {
		{Name: "chunks", Getter: "GetString", Req: "yes"},
	},
	"vfs/poll-interval": {
		{Name: "interval", Getter: "GetDuration", Req: "no"},
		{Name: "timeout", Getter: "GetDuration", Req: "no"},
	},
}

// Requiredness the parser gets wrong, because of how the code handles the error.
var requiredOverride = map[string]string{
	"cache/expire.remote":                     "yes", // in["remote"] with an explicit check
	"cache/expire.withData":                   "no",
	"config/unlock.configPassword":            "yes", // falls back to config_password, then errors
	"core/bwlimit.rate":                       "no",  // missing means read the current limit
	"core/command.command":                    "no",  // error replaced by a default
	"core/command.returnType":                 "no",  // error replaced by a default
	"core/stats-delete.group":                 "no",  // missing is accepted
	"operations/check.srcFs":                  "no",  // optional with checkFileHash
	"operations/check.checkFileFs":            "no",
	"operations/check.checkFileRemote":        "no",
	"pluginsctl/addPlugin.branch":             "no",  // error replaced by a default
	"pluginsctl/addPlugin.version":            "no",  // error replaced by a default
	"pluginsctl/getPluginsForType.type":       "no",  // error replaced by a default
	"pluginsctl/getPluginsForType.pluginType": "no",  // error replaced by a default
	"serve/start.type":                        "yes", // the error is ignored, then an empty type fails
	"job/batch._path":                         "no",  // belongs to the items, checked by the JSON schema
	"mount/mount.mountType":                   "no",  // error replaced by a default
}

// Response keys the parser finds that aren't top-level keys of the 200 response.
var ignoredResponseKeys = map[string][]string{
	"job/batch":   {"error", "input", "path", "status", "executeId", "jobid"}, // inside results items
	"vfs/refresh": {""},                                                       // result[""], inside the result map
}

// Response keys in the spec that come from a struct or a closure the parser can't read.
var opaqueResponseKeys = map[string][]string{
	"operations/check":  {"combined", "missingOnSrc", "missingOnDst", "match", "differ", "error"},
	"vfs/poll-interval": {},
}

// Routes registered in a loop. Their params come from reading the loop's body.
var dynamicRoutes = map[string]map[string][]Param{
	`"config/" + name`: {
		"config/create":   {req("name"), reqStruct("parameters"), opt("opt", "GetStruct"), opt("obscure", "GetBool"), opt("noObscure", "GetBool"), req("type")},
		"config/update":   {req("name"), reqStruct("parameters"), opt("opt", "GetStruct"), opt("obscure", "GetBool"), opt("noObscure", "GetBool")},
		"config/password": {req("name"), reqStruct("parameters"), opt("opt", "GetStruct"), opt("obscure", "GetBool"), opt("noObscure", "GetBool")},
	},
	`"operations/" + op.name`: {
		"operations/mkdir":       {reqFs("fs"), req("remote")},
		"operations/rmdir":       {reqFs("fs"), req("remote")},
		"operations/purge":       {reqFs("fs"), req("remote")},
		"operations/deletefile":  {reqFs("fs"), req("remote")},
		"operations/rmdirs":      {reqFs("fs"), req("remote"), opt("leaveRoot", "GetBool")},
		"operations/delete":      {reqFs("fs")},
		"operations/cleanup":     {reqFs("fs")},
		"operations/copyurl":     {reqFs("fs"), req("remote"), req("url"), opt("autoFilename", "GetBool"), opt("noClobber", "GetBool"), opt("headerFilename", "GetBool")},
		"operations/uploadfile":  {reqFs("fs"), req("remote")},
		"operations/settier":     {reqFs("fs"), req("tier")},
		"operations/settierfile": {reqFs("fs"), req("remote"), req("tier")},
	},
	`"operations/" + strings.ToLower(name) + "file"`: {
		"operations/copyfile": {reqFs("srcFs"), req("srcRemote"), reqFs("dstFs"), req("dstRemote")},
		"operations/movefile": {reqFs("srcFs"), req("srcRemote"), reqFs("dstFs"), req("dstRemote")},
	},
	`"sync/" + name`: {
		"sync/sync": {reqFs("srcFs"), reqFs("dstFs"), opt("createEmptySrcDirs", "GetBool")},
		"sync/copy": {reqFs("srcFs"), reqFs("dstFs"), opt("createEmptySrcDirs", "GetBool")},
		"sync/move": {reqFs("srcFs"), reqFs("dstFs"), opt("createEmptySrcDirs", "GetBool"), opt("deleteEmptySrcDirs", "GetBool")},
	},
}

func req(name string) Param   { return Param{Name: name, Getter: "GetString", Req: "yes"} }
func reqFs(name string) Param { return Param{Name: name, Getter: "GetFs", Req: "yes"} }
func reqStruct(name string) Param {
	return Param{Name: name, Getter: "GetStruct", Req: "yes"}
}
func opt(name, getter string) Param {
	return Param{Name: name, Getter: getter, Req: "no"}
}

// JSON types each getter accepts. nil means the getter doesn't check.
var accepts = map[string][]string{
	"GetString":          {"string"},
	"GetDuration":        {"string"},
	"GetFsDuration":      {"string"},
	"stringAssert":       {"string"},
	"GetBool":            {"boolean", "integer", "number", "string"},
	"GetInt64":           {"integer", "number", "string"},
	"GetInt":             {"integer", "number", "string"},
	"GetFloat64":         {"integer", "number", "string"},
	"GetFs":              {"string", "object"},
	"GetFsNamed":         {"string", "object"},
	"GetFsNamedFileOK":   {"string", "object"},
	"GetStruct":          {"object", "array", "string"},
	"GetStructMissingOK": {"object", "array", "string"},
}

// The type the spec should use, where rclone's getter also accepts others.
var natural = map[string]string{
	"GetBool":  "boolean",
	"GetInt64": "integer",
	"GetInt":   "integer",
}

type Param struct {
	Name   string
	Getter string
	Req    string // yes, no or ?
	Pos    string
}

type Route struct {
	Path    string
	PathX   string
	Pos     string
	NoAuth  bool
	Params  []Param
	Out     []string
	RangeIn bool
}

type fileInfo struct {
	f       *ast.File
	dir     string
	imports map[string]string
}

type fn struct {
	decl *ast.FuncDecl
	fi   *fileInfo
}

var (
	fset  = token.NewFileSet()
	funcs = map[string]map[string][]fn{}
	files []*fileInfo
	root  string
)

func src(n ast.Node) string {
	var b bytes.Buffer
	_ = printer.Fprint(&b, fset, n)
	return b.String()
}

func pos(n ast.Node) string {
	p := fset.Position(n.Pos())
	r, _ := filepath.Rel(root, p.Filename)
	return fmt.Sprintf("%s:%d", r, p.Line)
}

var getters = map[string]bool{
	"Get": true, "GetString": true, "GetBool": true, "GetInt64": true, "GetInt": true, "GetFloat64": true,
	"GetDuration": true, "GetFsDuration": true, "GetStruct": true, "GetStructMissingOK": true,
}

// Helpers that read params by a name passed as an argument.
func helperParams(name string, c *ast.CallExpr) ([]string, string) {
	lit := func(i int) string {
		if i < len(c.Args) {
			if b, ok := c.Args[i].(*ast.BasicLit); ok {
				s, _ := strconv.Unquote(b.Value)
				return s
			}
			return "<" + src(c.Args[i]) + ">"
		}
		return "?"
	}
	switch name {
	case "GetFs":
		return []string{"fs"}, "GetFs"
	case "GetFsNamed", "GetFsNamedFileOK":
		return []string{lit(2)}, "GetFs"
	case "GetFsAndRemote":
		return []string{"fs", "remote"}, "GetFsAndRemote"
	case "GetFsAndRemoteNamed":
		return []string{lit(2), lit(3)}, "GetFsAndRemote"
	case "setEnum":
		return []string{lit(1)}, "GetString"
	case "ParseOptions":
		return []string{lit(1)}, "GetStruct"
	}
	return nil, ""
}

func reqFrom(stmts []ast.Stmt, i int) string {
	s := stmts[i]
	if ifs, ok := s.(*ast.IfStmt); ok {
		c := src(ifs.Cond)
		body := src(ifs.Body)
		if strings.Contains(c, "ParamNotFound") || strings.Contains(body, "ParamNotFound") {
			return "no"
		}
		if strings.Contains(c, "== nil") {
			return "no"
		}
		if strings.Contains(c, "err != nil") {
			return "yes"
		}
		return "?"
	}
	if as, ok := s.(*ast.AssignStmt); ok && len(as.Lhs) >= 2 {
		if id, ok := as.Lhs[len(as.Lhs)-1].(*ast.Ident); ok && id.Name == "_" {
			return "no"
		}
	}
	for j := i + 1; j < len(stmts) && j <= i+3; j++ {
		if strings.Contains(src(stmts[j]), "ParamNotFound") {
			return "no"
		}
		if ifs, ok := stmts[j].(*ast.IfStmt); ok {
			c := src(ifs.Cond)
			if strings.Contains(c, "err == nil") {
				return "no"
			}
			if strings.Contains(c, "err != nil") {
				return "yes"
			}
		}
	}
	return "?"
}

type walker struct {
	r    *Route
	seen map[string]bool
}

func (w *walker) add(p Param) {
	for i, e := range w.r.Params {
		if e.Name == p.Name {
			if e.Req == "?" || (e.Req == "no" && p.Req == "yes") {
				w.r.Params[i].Req = p.Req
			}
			return
		}
	}
	w.r.Params = append(w.r.Params, p)
}

func (w *walker) resolve(fi *fileInfo, c *ast.CallExpr) []fn {
	switch f := c.Fun.(type) {
	case *ast.Ident:
		return funcs[fi.dir][f.Name]
	case *ast.SelectorExpr:
		if id, ok := f.X.(*ast.Ident); ok {
			if d, ok := fi.imports[id.Name]; ok {
				return funcs[d][f.Sel.Name]
			}
		}
		return funcs[fi.dir][f.Sel.Name]
	}
	return nil
}

func calleeName(c *ast.CallExpr) (string, string) {
	switch f := c.Fun.(type) {
	case *ast.Ident:
		return "", f.Name
	case *ast.SelectorExpr:
		return src(f.X), f.Sel.Name
	}
	return "", ""
}

func paramNames(t *ast.FuncType) []string {
	names := []string{}
	for _, fld := range t.Params.List {
		if len(fld.Names) == 0 {
			names = append(names, "_")
		}
		for _, nm := range fld.Names {
			names = append(names, nm.Name)
		}
	}
	return names
}

func (w *walker) walkBody(body ast.Node, in map[string]bool, fi *fileInfo) {
	reqs := map[*ast.CallExpr]string{}
	ast.Inspect(body, func(n ast.Node) bool {
		b, ok := n.(*ast.BlockStmt)
		if !ok {
			return true
		}
		for i, s := range b.List {
			var scan []ast.Node
			switch t := s.(type) {
			case *ast.AssignStmt:
				for _, e := range t.Rhs {
					scan = append(scan, e)
				}
			case *ast.IfStmt:
				if t.Init != nil {
					scan = append(scan, t.Init)
				}
			case *ast.ExprStmt:
				scan = append(scan, t.X)
			case *ast.DeclStmt:
				scan = append(scan, t)
			}
			for _, sc := range scan {
				ast.Inspect(sc, func(m ast.Node) bool {
					if _, isLit := m.(*ast.FuncLit); isLit {
						return false
					}
					if ce, ok := m.(*ast.CallExpr); ok {
						if _, done := reqs[ce]; !done {
							reqs[ce] = reqFrom(b.List, i)
						}
					}
					return true
				})
			}
		}
		return true
	})

	ast.Inspect(body, func(n ast.Node) bool {
		switch t := n.(type) {
		case *ast.RangeStmt:
			if id, ok := t.X.(*ast.Ident); ok && in[id.Name] {
				w.r.RangeIn = true
			}
		case *ast.IndexExpr:
			if id, ok := t.X.(*ast.Ident); ok {
				if lit, ok := t.Index.(*ast.BasicLit); ok {
					k, _ := strconv.Unquote(lit.Value)
					if in[id.Name] {
						w.add(Param{Name: k, Getter: "index", Req: "?", Pos: pos(t)})
					} else if id.Name == "out" || id.Name == "result" || id.Name == "res" || id.Name == "params" {
						w.r.Out = append(w.r.Out, k)
					}
				}
			}
		case *ast.CompositeLit:
			ts := ""
			if t.Type != nil {
				ts = src(t.Type)
			}
			if ts == "rc.Params" || ts == "Params" {
				for _, e := range t.Elts {
					if kv, ok := e.(*ast.KeyValueExpr); ok {
						if lit, ok := kv.Key.(*ast.BasicLit); ok {
							k, _ := strconv.Unquote(lit.Value)
							w.r.Out = append(w.r.Out, k)
						}
					}
				}
			}
		case *ast.CallExpr:
			recv, name := calleeName(t)
			if getters[name] && in[recv] && len(t.Args) >= 1 {
				lit, isLit := t.Args[0].(*ast.BasicLit)
				if !isLit {
					return true
				}
				k, _ := strconv.Unquote(lit.Value)
				r := reqs[t]
				if r == "" {
					r = "?"
				}
				if name == "GetStructMissingOK" {
					r = "no"
				}
				w.add(Param{Name: k, Getter: name, Req: r, Pos: pos(t)})
				return true
			}
			if hp, getter := helperParams(name, t); hp != nil {
				passes := false
				for _, a := range t.Args {
					if id, ok := a.(*ast.Ident); ok && in[id.Name] {
						passes = true
					}
				}
				if passes {
					r := reqs[t]
					if r == "" {
						r = "?"
					}
					if name == "setEnum" || name == "ParseOptions" {
						r = "no"
					}
					for _, k := range hp {
						if !strings.HasPrefix(k, "<") {
							w.add(Param{Name: k, Getter: getter, Req: r, Pos: pos(t)})
						}
					}
					return true
				}
			}
			for i, a := range t.Args {
				id, ok := a.(*ast.Ident)
				if !ok || !in[id.Name] {
					continue
				}
				for _, target := range w.resolve(fi, t) {
					key := pos(target.decl)
					if w.seen[key] || target.decl.Body == nil {
						continue
					}
					w.seen[key] = true
					names := paramNames(target.decl.Type)
					if i < len(names) {
						w.walkBody(target.decl.Body, map[string]bool{names[i]: true}, target.fi)
					}
				}
			}
		}
		return true
	})
}

func parseTree() {
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if n := info.Name(); n == ".git" || n == "testdata" || n == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, "parse:", p, err)
			return nil
		}
		dir, _ := filepath.Rel(root, filepath.Dir(p))
		fi := &fileInfo{f: f, dir: dir, imports: map[string]string{}}
		for _, im := range f.Imports {
			ip, _ := strconv.Unquote(im.Path.Value)
			if strings.HasPrefix(ip, modPrefix) {
				d := strings.TrimPrefix(ip, modPrefix)
				nm := filepath.Base(d)
				if im.Name != nil {
					nm = im.Name.Name
				}
				fi.imports[nm] = d
			}
		}
		files = append(files, fi)
		if funcs[dir] == nil {
			funcs[dir] = map[string][]fn{}
		}
		for _, d := range f.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok {
				funcs[dir][fd.Name.Name] = append(funcs[dir][fd.Name.Name], fn{fd, fi})
			}
		}
		return nil
	})
	if err != nil {
		fatal(err)
	}
}

func inventory() []*Route {
	var routes []*Route
	for _, fi := range files {
		fi := fi
		ast.Inspect(fi.f, func(n ast.Node) bool {
			cl, ok := n.(*ast.CompositeLit)
			if !ok || cl.Type == nil {
				return true
			}
			ts := src(cl.Type)
			if ts != "rc.Call" && !(ts == "Call" && fi.dir == filepath.Join("fs", "rc")) {
				return true
			}
			r := &Route{Pos: pos(cl)}
			var fnExpr ast.Expr
			for _, e := range cl.Elts {
				kv, ok := e.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				switch src(kv.Key) {
				case "Path":
					if b, ok := kv.Value.(*ast.BasicLit); ok {
						r.Path, _ = strconv.Unquote(b.Value)
					} else {
						r.PathX = src(kv.Value)
					}
				case "NoAuth":
					r.NoAuth = src(kv.Value) == "true"
				case "Fn":
					fnExpr = kv.Value
				}
			}
			if r.Path == "" && r.PathX == "" {
				return true
			}
			w := &walker{r: r, seen: map[string]bool{}}
			switch f := fnExpr.(type) {
			case *ast.FuncLit:
				names := paramNames(f.Type)
				if len(names) >= 2 {
					w.walkBody(f.Body, map[string]bool{names[1]: true}, fi)
				}
			case nil:
			default:
				name := ""
				switch g := f.(type) {
				case *ast.Ident:
					name = g.Name
				case *ast.SelectorExpr:
					name = g.Sel.Name
				case *ast.CallExpr:
					_, name = calleeName(g)
				}
				for _, t := range funcs[fi.dir][name] {
					if t.decl.Body == nil {
						continue
					}
					names := paramNames(t.decl.Type)
					if len(names) >= 2 {
						w.walkBody(t.decl.Body, map[string]bool{names[1]: true}, t.fi)
					}
				}
			}
			routes = append(routes, r)
			return true
		})
	}
	return routes
}

// --- The spec -----------------------------------------------------------------

type obj = map[string]any

var doc obj

func deref(node any) obj {
	m, _ := node.(obj)
	if m == nil {
		return nil
	}
	if ref, ok := m["$ref"].(string); ok {
		var cur any = doc
		for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
			part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
			cur = cur.(obj)[part]
		}
		return deref(cur)
	}
	return m
}

func collect(schema any) (map[string]any, map[string]bool) {
	props, required := map[string]any{}, map[string]bool{}
	s := deref(schema)
	if s == nil {
		return props, required
	}
	for _, key := range []string{"allOf", "anyOf", "oneOf"} {
		if parts, ok := s[key].([]any); ok {
			for _, part := range parts {
				p, r := collect(part)
				for k, v := range p {
					props[k] = v
				}
				if key == "allOf" {
					for k := range r {
						required[k] = true
					}
				}
			}
		}
	}
	if p, ok := s["properties"].(obj); ok {
		for k, v := range p {
			props[k] = v
		}
	}
	if r, ok := s["required"].([]any); ok {
		for _, k := range r {
			required[k.(string)] = true
		}
	}
	return props, required
}

func specTypes(schema any) []string {
	s := deref(schema)
	if s == nil {
		return nil
	}
	switch t := s["type"].(type) {
	case string:
		return []string{t}
	case []any:
		out := []string{}
		for _, x := range t {
			out = append(out, x.(string))
		}
		return out
	}
	out := []string{}
	for _, key := range []string{"anyOf", "oneOf"} {
		if parts, ok := s[key].([]any); ok {
			for _, part := range parts {
				out = append(out, specTypes(part)...)
			}
		}
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// --- Comparing ----------------------------------------------------------------

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func resolveVersion() string {
	wanted := os.Getenv("OPENAPI_RCLONE_VERSION")
	if wanted == "" {
		data, err := os.ReadFile("package.json")
		if err != nil {
			fatal(err)
		}
		var pkg struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(data, &pkg); err != nil {
			fatal(err)
		}
		wanted = pkg.Version
	}
	if wanted != "latest" {
		return strings.TrimPrefix(wanted, "v")
	}
	resp, err := http.Get("https://downloads.rclone.org/version.txt")
	if err != nil {
		fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fatal(err)
	}
	return strings.TrimPrefix(strings.TrimSpace(string(body)), "rclone v")
}

func ensureSource(version string) string {
	dir := filepath.Join(".work", "cache", "rclone-src-v"+version)
	if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
		return dir
	}
	fmt.Println("Fetching the source of rclone v" + version)
	cmd := exec.Command("git", "-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", "v"+version, "--single-branch", "https://github.com/rclone/rclone.git", dir)
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fatal(err)
	}
	return dir
}

func main() {
	version := resolveVersion()
	root = ensureSource(version)
	parseTree()

	data, err := os.ReadFile("openapi.json")
	if err != nil {
		fatal(err)
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		fatal(err)
	}
	paths := doc["paths"].(obj)

	var problems []string
	problem := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	// Expand the routes registered in loops
	source := map[string]*Route{}
	for _, r := range inventory() {
		if r.PathX == "" {
			source[r.Path] = r
			continue
		}
		table, known := dynamicRoutes[r.PathX]
		if !known {
			problem("%s: route registered with %s, which the audit doesn't know about", r.Pos, r.PathX)
			continue
		}
		listed := map[string]bool{}
		for path, params := range table {
			source[path] = &Route{Path: path, Pos: r.Pos, NoAuth: r.NoAuth, Params: params}
			for _, p := range params {
				listed[p.Name] = true
			}
		}
		for _, p := range r.Params {
			if !listed[p.Name] {
				problem("%s: %s reads %s, which the audit's table doesn't list", r.Pos, r.PathX, p.Name)
			}
		}
	}
	for path, extra := range extraParams {
		if r := source[path]; r != nil {
			w := &walker{r: r}
			for _, p := range extra {
				w.add(p)
			}
		}
	}

	// Routes
	for path := range source {
		if _, ok := paths["/"+path]; !ok && notInSpec[path] == "" {
			problem("routes: %s is in rclone but not in the spec", path)
		}
	}
	names := make([]string, 0, len(paths))
	for p := range paths {
		names = append(names, p)
	}
	sort.Strings(names)

	checked := 0
	for _, p := range names {
		path := strings.TrimPrefix(p, "/")
		r := source[path]
		if r == nil {
			problem("routes: %s is in the spec but not in rclone", path)
			continue
		}
		op := paths[p].(obj)["post"].(obj)

		// What the spec says this route takes
		content, _ := deref(op["requestBody"])["content"].(obj)
		var body any
		if content != nil {
			if media, ok := content["application/json"].(obj); ok {
				body = media["schema"]
			}
		}
		props, required := collect(body)
		if params, ok := op["parameters"].([]any); ok {
			for _, ref := range params {
				param := deref(ref)
				if param["in"] == "query" {
					props[param["name"].(string)] = param["schema"]
					if param["required"] == true {
						required[param["name"].(string)] = true
					}
				}
			}
		}

		read := map[string]Param{}
		for _, param := range r.Params {
			read[param.Name] = param
		}

		// Params
		for name := range props {
			checked++
			if strings.HasPrefix(name, "_") {
				continue
			}
			if _, ok := read[name]; !ok && !r.RangeIn {
				problem("params: %s documents %s, but rclone never reads it", path, name)
			}
		}
		for _, param := range r.Params {
			name := param.Name
			if strings.HasPrefix(name, "_") || contains(undocumentedParams[path], name) {
				continue
			}
			if _, ok := props[name]; !ok {
				problem("params: %s reads %s (%s), but the spec doesn't document it", path, name, param.Pos)
				continue
			}

			// Requiredness
			want := param.Req
			if o, ok := requiredOverride[path+"."+name]; ok {
				want = o
			}
			if want == "?" {
				problem("required: can't tell whether %s.%s is required (%s)", path, name, param.Pos)
			} else if want == "yes" && !required[name] {
				problem("required: rclone needs %s.%s, but the spec doesn't require it", path, name)
			} else if want == "no" && required[name] {
				problem("required: the spec requires %s.%s, but rclone doesn't need it", path, name)
			}

			// Types in a JSON body
			getter := param.Getter
			if getter == "GetFsAndRemote" {
				getter = "GetFs"
				if strings.HasSuffix(strings.ToLower(name), "remote") {
					getter = "GetString"
				}
			}
			allowed, known := accepts[getter]
			types := []string{}
			for _, t := range specTypes(props[name]) {
				if t != "null" {
					types = append(types, t)
				}
			}
			if known {
				for _, t := range types {
					if !contains(allowed, t) {
						problem("types: %s.%s is %s in the spec, but rclone reads it with %s, which rejects that in JSON", path, name, t, getter)
					}
				}
			}
			if nat, ok := natural[getter]; ok && len(types) > 0 && !contains(types, nat) {
				problem("types: %s.%s is %s in the spec, but rclone reads a %s", path, name, strings.Join(types, "|"), nat)
			}
		}

		// Response keys
		if len(r.Out) > 0 {
			resp := deref(deref(op["responses"])["200"])
			respProps := map[string]any{}
			if c, ok := resp["content"].(obj); ok {
				if media, ok := c["application/json"].(obj); ok {
					respProps, _ = collect(media["schema"])
				}
			}
			seen := map[string]bool{}
			for _, k := range r.Out {
				seen[k] = true
				if _, ok := respProps[k]; !ok && !contains(ignoredResponseKeys[path], k) {
					problem("response: %s returns %s, but the spec doesn't document it", path, k)
				}
			}
			for k := range respProps {
				if !seen[k] && !contains(opaqueResponseKeys[path], k) {
					problem("response: %s documents %s, but the code doesn't appear to return it", path, k)
				}
			}
		}

		// Auth
		if _, on := doc["security"]; on {
			security, has := op["security"].([]any)
			open := has && len(security) == 0
			if open != r.NoAuth {
				problem("auth: rclone says NoAuth=%v for %s, but the spec says no auth=%v", r.NoAuth, path, open)
			}
		}
	}

	sort.Strings(problems)
	fmt.Printf("Audited %d routes and %d documented fields against the source of rclone v%s.\n", len(names), checked, version)
	if len(problems) > 0 {
		fmt.Fprintf(os.Stderr, "\n%d problems:\n\n", len(problems))
		for _, p := range problems {
			fmt.Fprintln(os.Stderr, "  "+p)
		}
		os.Exit(1)
	}
	fmt.Println("The spec matches the source.")
}
