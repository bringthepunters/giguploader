#!/usr/bin/env python3
import argparse
import requests
import sys
import os
from bs4 import BeautifulSoup
from datetime import datetime, timedelta


def get_monday_of_current_week():
    """Get the date of Monday for the current week."""
    today = datetime.now()
    # Get the day of the week as an integer (0 is Monday, 6 is Sunday)
    weekday = today.weekday()
    # Calculate the date of Monday by subtracting the weekday number
    monday = today - timedelta(days=weekday)
    # Format as YYYY-MM-DD
    return monday.strftime("%Y-%m-%d")


def default_source_name():
    """Generate a default source name with the Monday of the current week."""
    monday_date = get_monday_of_current_week()
    return f"Automated for week of {monday_date}"


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description='Upload data to LML Rails admin endpoint.')
    parser.add_argument('-s', '--source', help='Source label for the upload')
    parser.add_argument('-c', '--content', required=True, help='Path to content file')
    parser.add_argument('-u', '--url', default='https://api.lml.live', help='Base URL of the Rails application')
    parser.add_argument('-v', '--verbose', action='store_true', help='Enable verbose output')
    
    args = parser.parse_args()
    
    # Set default source if not provided
    if not args.source:
        args.source = default_source_name()
        print(f"Using default source: \"{args.source}\"")
    
    return args


def load_content_file(filename):
    """Load content from a file."""
    try:
        with open(filename, 'r') as f:
            content = f.read()
        return content
    except FileNotFoundError:
        print(f"Error: File {filename} not found.")
        sys.exit(1)
    except Exception as e:
        print(f"Error reading file: {e}")
        sys.exit(1)


def load_session_id():
    """Load session ID from .lml_session_id file."""
    session_file = '.lml_session_id'
    try:
        with open(session_file, 'r') as f:
            session_id = f.read().strip()
        print(f"Loaded session ID from {session_file}")
        return session_id
    except FileNotFoundError:
        print(f"Error: Session ID file {session_file} not found.")
        sys.exit(1)
    except Exception as e:
        print(f"Error loading session ID: {e}")
        sys.exit(1)


def get_csrf_token(session, url, verbose=False):
    """Fetch a new CSRF token from the form page."""
    form_url = f"{url.rstrip('/')}/admin/uploads/new"
    print(f"Fetching CSRF token from {form_url}")
    
    try:
        response = session.get(form_url)
        response.raise_for_status()
        
        # Check if we're on the right page by verifying the form exists
        soup = BeautifulSoup(response.text, 'html.parser')
        form = soup.find('form', {'action': '/admin/uploads'})
        
        if not form:
            print("Error: Could not find the upload form. You may not be authenticated properly.")
            if verbose:
                print("Response HTML (first 500 chars):")
                print(response.text[:500] + "..." if len(response.text) > 500 else response.text)
            sys.exit(1)
        
        # Extract token using BeautifulSoup
        token_input = soup.find('input', {'name': 'authenticity_token'})
        
        if token_input and 'value' in token_input.attrs:
            token = token_input['value']
            print(f"Found CSRF token: {token[:10]}...{token[-10:]} (truncated)")
            return token
        
        print("Error: Could not find CSRF token in the page")
        if verbose:
            print("Response HTML (first 500 chars):")
            print(response.text[:500] + "..." if len(response.text) > 500 else response.text)
        sys.exit(1)
        
    except requests.exceptions.RequestException as e:
        print(f"Error fetching CSRF token: {e}")
        sys.exit(1)


def submit_to_rails(url, source, content, session, verbose=False):
    """Submit data to Rails endpoint using essential headers."""
    # Construct the full URL
    endpoint = f"{url.rstrip('/')}/admin/uploads"
    
    # Set only essential headers
    headers = {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': url,
        'referer': f"{url.rstrip('/')}/admin/uploads/new",
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    }
    
    # Get CSRF token first
    csrf_token = get_csrf_token(session, url, verbose)
    
    # Prepare form data
    form_data = {
        'authenticity_token': csrf_token,
        'lml_upload[venue_label]': '',
        'lml_upload[venue_id]': '',
        'lml_upload[source]': source,
        'lml_upload[content]': content,
        'commit': 'Create Upload'
    }
    
    if verbose:
        print("\n=== Request Details ===")
        print(f"URL: {endpoint}")
        print("Headers:")
        for key, value in headers.items():
            print(f"  {key}: {value}")
        print("Form Data:")
        for key, value in form_data.items():
            if key == 'lml_upload[content]' and len(str(value)) > 100:
                print(f"  {key}: {str(value)[:100]}... (truncated)")
            elif key == 'authenticity_token':
                print(f"  {key}: {value[:10]}...{value[-10:]} (truncated)")
            else:
                print(f"  {key}: {value}")
    
    # Make the request
    try:
        response = session.post(endpoint, data=form_data, headers=headers, allow_redirects=False)
        
        if verbose:
            print("\n=== Response Details ===")
            print(f"Status Code: {response.status_code}")
            print("Response Headers:")
            for key, value in response.headers.items():
                print(f"  {key}: {value}")
            
            if len(response.text) > 0:
                print(f"Response Body (first 500 chars):")
                print(response.text[:500] + "..." if len(response.text) > 500 else response.text)
        
        # Success is often indicated by a 302 redirect in Rails
        if response.status_code == 302:
            redirect_url = response.headers.get('Location')
            print(f"Success! Redirected to: {redirect_url}")
            return True
        elif response.status_code in [200, 201]:
            print(f"Success! Status code: {response.status_code}")
            return True
        else:
            print(f"Unexpected status code: {response.status_code}")
            
            # Try to parse response for potential error messages
            if response.status_code == 422:
                soup = BeautifulSoup(response.text, 'html.parser')
                error_messages = soup.select('.error_messages, .alert, .flash, .field_with_errors')
                if error_messages:
                    print("\nError messages found in response:")
                    for error in error_messages:
                        print(f"  - {error.get_text().strip()}")
            
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"Error sending request: {e}")
        
        if hasattr(e, 'response') and e.response is not None:
            print(f"Response status: {e.response.status_code}")
            print(f"Response body: {e.response.text[:500]}..." if len(e.response.text) > 500 else f"Response body: {e.response.text}")
        
        return False


def main():
    """Main function to run the script."""
    args = parse_arguments()
    
    # Load content from file
    content = load_content_file(args.content)
    
    # Create a session
    session = requests.Session()
    
    # Set up session cookie
    session_id = load_session_id()
    session.cookies.set('_lml_session', session_id)
    
    print(f"\nSubmitting data to {args.url}/admin/uploads")
    print(f"Source: {args.source}")
    print(f"Content file: {args.content}")
    
    result = submit_to_rails(args.url, args.source, content, session, args.verbose)
    
    if result:
        print("\nUpload completed successfully!")
    else:
        print("\nUpload failed.")
        sys.exit(1)


if __name__ == "__main__":
    main()