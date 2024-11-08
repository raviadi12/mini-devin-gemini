import systry:
    num_terms = int(sys.argv[1])
except IndexError:
    print('Usage: python fibonacci.py <number_of_terms>')
    sys.exit(1)
except ValueError:
    print('Invalid input. Please enter an integer.')
    sys.exit(1)
def fibonacci_iterative(n):
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
iterative_result = fibonacci_iterative(num_terms)
print('Iterative approach:', iterative_result)
def fibonacci_recursive(n):
    if n <= 0:
        return []
    elif n == 1:
        return [0]
    elif n == 2:
        return [0, 1]
    else:
        list_fib = fibonacci_recursive(n-1)
        list_fib.append(list_fib[-1] + list_fib[-2])
        return list_fib
recursive_result = fibonacci_recursive(num_terms)
print('Recursive approach:', recursive_result)
print('Warning: Recursive approach can be slow for large inputs.')