import sys
# ... (previous code) ...
while True:
    # ... (input and calculation code) ...
    another_calculation = input('Calculate another Fibonacci number? (y/n): ')
    if another_calculation.lower() != 'y':
        break