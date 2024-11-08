import sys
n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
for i in fibonacci(n):
    print(i)
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b
#!/usr/bin/env python3
for i in fibonacci(n):
    print(i)
import sys
n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
#!/usr/bin/env python3
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b
