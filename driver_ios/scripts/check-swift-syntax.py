"""Windows-compatible grammar check; not a substitute for the Xcode compiler."""
from pathlib import Path
import sys
from tree_sitter import Language, Parser
import tree_sitter_swift

root = Path(__file__).resolve().parents[1]
parser = Parser(Language(tree_sitter_swift.language()))
failures = []
sources = [root / "Package.swift", *root.glob("Sources/**/*.swift"), *root.glob("Tests/**/*.swift"), *root.glob("UITests/**/*.swift")]
for source in sources:
    tree = parser.parse(source.read_bytes())
    pending = [tree.root_node]
    while pending:
        node = pending.pop()
        if node.type == "ERROR" or node.is_missing:
            failures.append(f"{source.relative_to(root)}:{node.start_point.row + 1}: {node.type}")
        pending.extend(node.children)
if failures:
    print("\n".join(failures))
    sys.exit(1)
print(f"Swift grammar check passed for {len(sources)} files. Compilation still requires Xcode.")
