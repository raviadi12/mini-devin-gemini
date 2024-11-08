import systry:
    num_terms = int(sys.argv[1])
except IndexError:
    print('Usage: python fibonacci_sequence.py <number_of_terms>')
    sys.exit(1)
except ValueError:
    print('Invalid input. Please enter an integer.')
    sys.exit(1)
def fibonacci_sequence(n):
    if n <= 0:
        return []
    elif n == 1:
        return [0]
    else:
        list_fib = [0, 1]
        while len(list_fib) < n:
            next_fib = list_fib[-1] + list_fib[-2]
            list_fib.append(next_fib)
        return list_fib
result = fibonacci_sequence(num_terms)
print(result)
