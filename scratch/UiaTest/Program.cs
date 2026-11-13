using System;
using System.Windows.Automation;

class Program
{
    static void Main()
    {
        var root = AutomationElement.RootElement;
        Console.WriteLine($"Root: {root.Current.Name}");
    }
}

