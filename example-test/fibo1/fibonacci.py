# Simple Fibonacci sequence generatorimport sys
try:
    num_terms = int(sys.argv[1])
    if num_terms <= 0:
        print('Please enter a positive integer.')
        sys.exit(1)
except IndexError:
    print('Usage: python fibonacci.py <number_of_terms>')
    sys.exit(1)
except ValueError:
    print('Invalid input. Please enter an integer.')
    sys.exit(1)
a, b = 0, 1
fibonacci_sequence = []
for _ in range(num_terms):
    fibonacci_sequence.append(a)
    a, b = b, a + b
print(fibonacci_sequence)
