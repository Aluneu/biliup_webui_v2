import os, re, sys

root = r'app'
changed = []

for dp, dn, fn in os.walk(root):
    for f in fn:
        if not f.endswith(('.ts', '.tsx', '.jsx', '.js')):
            continue
        p = os.path.join(dp, f)
        if p.endswith(os.path.join('lib', 'nav.tsx')):
            continue
        s = open(p, encoding='utf-8').read()
        orig = s

        # 1) next/link -> nav shim
        s = s.replace("import Link from 'next/link'", "import Link from '@/app/lib/nav'")

        # 2) useRouter from next/navigation -> nav shim
        #    注意：只有当这一行**确实导入了 useRouter** 时才加 shim 的导入，否则会多出一条
        #    重复/无用的 `import { useRouter } from '@/app/lib/nav'`（会触发重复声明报错）
        def fix_nav(m):
            names = [n.strip() for n in m.group(1).split(',') if n.strip()]
            uses_router = any(n.split(' as ')[0].strip() == 'useRouter' for n in names)
            keep = [n for n in names if n.split(' as ')[0].strip() != 'useRouter']
            if not uses_router:
                return m.group(0)
            out = []
            if keep:
                out.append("import { %s } from 'next/navigation'" % ', '.join(keep))
            out.append("import { useRouter } from '@/app/lib/nav'")
            return '\n'.join(out)

        s = re.sub(r"import \{([^}]*)\} from 'next/navigation'", fix_nav, s)

        if s != orig:
            open(p, 'w', encoding='utf-8', newline='').write(s)
            changed.append(os.path.relpath(p, root).replace('\\', '/'))

print('changed', len(changed))
for c in sorted(changed):
    print(' ', c)

